// Socket.IO real-time layer (GUIDE #8 A).
//
// Rooms (server-computed, never chosen by the client):
//   all           SUPER_ADMIN, DEPARTMENT_ADMIN
//   zone:<id>     ZONE_ADMIN          ward:<id>  WARD_SUPERVISOR          agency:<id>  AGENCY_USER
// Events:
//   vehicle:locations  [{vehicle_id, lat, lng, speed, ignition, heading, recorded_at, connection_status}]
//                      from gpsEvents 'ingested'; throttled per room to ≤ 1 emit / 2 s (latest per vehicle)
//   pid:status         { changes: [{route_assignment_id, pid_id, old_status, new_status}], assignments: [counts] }
//                      from gpsEvents 'detected'
//   provider:status    { provider, state, reason, last_success_at } when the derived state changes
// Each payload goes to 'all' + the vehicle's zone / ward / agency rooms.
//
// SCALING NOTE: only the GPS / detection leader produces these events, and rooms live in this process'
// memory. We run a single API instance. Running several instances requires @socket.io/redis-adapter
// (shared rooms) — not implemented.
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { db as defaultDb } from '../config/database.js';
import { verifyToken } from '../services/tokenService.js';
import { userRepository } from '../repositories/userRepository.js';
import { gpsEvents } from '../services/gps/gpsEvents.js';
import { providerStatus } from '../services/gps/gpsReadService.js';
import { getSetting } from '../services/settingsService.js';
import { logger as rootLogger } from '../utils/logger.js';

/** The ONE room a user may join, from server-side data only; null = nothing (fail closed). */
export function roomForUser(u) {
  switch (u?.role_key) {
    case 'SUPER_ADMIN':
    case 'DEPARTMENT_ADMIN': return 'all';
    case 'ZONE_ADMIN': return u.zone_id ? `zone:${u.zone_id}` : null;
    case 'WARD_SUPERVISOR': return u.ward_id ? `ward:${u.ward_id}` : null;
    case 'AGENCY_USER': return u.agency_id ? `agency:${u.agency_id}` : null;
    default: return null;
  }
}

export const roomsForScope = ({ zone_id: z, ward_id: w, agency_id: a }) =>
  ['all', z && `zone:${z}`, w && `ward:${w}`, a && `agency:${a}`].filter(Boolean);

export function attachRealtime(httpServer, {
  db = defaultDb, events = gpsEvents, logger = rootLogger, throttleMs = 2000, recheckMs = 5 * 60_000,
  mapRefreshMs = 60_000, corsOrigin = env.CORS_ORIGIN,
} = {}) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: corsOrigin.split(',').map((s) => s.trim()), credentials: true },
  });

  // ---- handshake auth: same checks as the REST authenticate middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('unauthorized'));
      const payload = verifyToken(token);
      const u = await userRepository.findAuthById(Number(payload.sub));
      if (!u || u.status !== 'ACTIVE') return next(new Error('unauthorized'));
      if ((payload.tv ?? 0) !== u.token_version) return next(new Error('unauthorized')); // revoked session (GUIDE #11 C2)
      socket.data.user = u;
      socket.data.tv = payload.tv ?? 0;
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const room = roomForUser(socket.data.user);
    if (room) socket.join(room);
    socket.emit('ready', { room });
  });

  // ---- periodic re-check: one query for all connected users; deactivated or revoked session -> disconnect
  async function recheckUsers() {
    const sockets = await io.fetchSockets();
    const ids = [...new Set(sockets.map((s) => s.data.user.id))];
    if (!ids.length) return;
    const { rows } = await db.query("SELECT id, token_version FROM users WHERE id = ANY($1::bigint[]) AND status = 'ACTIVE'", [ids]);
    const active = new Map(rows.map((r) => [Number(r.id), Number(r.token_version)]));
    for (const s of sockets) {
      const tv = active.get(Number(s.data.user.id));
      if (tv === undefined || tv !== (s.data.tv ?? 0)) {
        s.emit('unauthorized', { reason: tv === undefined ? 'User is no longer active' : 'Session ended (signed out everywhere or password changed)' });
        s.disconnect(true);
      }
    }
  }

  // ---- vehicle -> scope map (one query per refresh, not per event)
  let scopeMap = new Map();
  let scopeLoadedAt = 0;
  async function vehicleScopes(ids) {
    const missing = ids.some((id) => !scopeMap.has(id));
    if (!scopeLoadedAt || Date.now() - scopeLoadedAt > mapRefreshMs || (missing && Date.now() - scopeLoadedAt > 10_000)) {
      const { rows } = await db.query('SELECT id, zone_id, ward_id, agency_id FROM vehicles');
      scopeMap = new Map(rows.map((r) => [Number(r.id), r]));
      scopeLoadedAt = Date.now();
    }
    return scopeMap;
  }

  // ---- throttled per-room vehicle location buffers
  const buffers = new Map(); // room -> Map(vehicle_id -> payload)
  const timers = new Map(); // room -> timeout
  const lastEmit = new Map(); // room -> ms
  function queue(room, item) {
    if (!buffers.has(room)) buffers.set(room, new Map());
    buffers.get(room).set(item.vehicle_id, item); // latest point per vehicle wins
    if (timers.has(room)) return;
    const wait = Math.max(0, (lastEmit.get(room) ?? 0) + throttleMs - Date.now());
    const t = setTimeout(() => {
      timers.delete(room);
      const items = [...(buffers.get(room)?.values() || [])];
      buffers.delete(room);
      lastEmit.set(room, Date.now());
      if (items.length) io.to(room).emit('vehicle:locations', items);
    }, wait);
    t.unref?.();
    timers.set(room, t);
  }

  async function onIngested({ vehicleIds }) {
    if (!vehicleIds?.length) return;
    const offlineS = Number(await getSetting('gps.offline_after_seconds', 300)) || 300;
    const { rows } = await db.query(
      `SELECT l.vehicle_id, l.latitude AS lat, l.longitude AS lng, l.speed, l.ignition, l.heading, l.recorded_at
         FROM vehicle_latest_locations l
        WHERE l.vehicle_id = ANY($1::int[])`, [vehicleIds]);
    const scopes = await vehicleScopes(rows.map((r) => Number(r.vehicle_id)));
    for (const r of rows) {
      const item = {
        ...r, vehicle_id: Number(r.vehicle_id),
        connection_status: Date.now() - new Date(r.recorded_at).getTime() <= offlineS * 1000 ? 'ONLINE' : 'OFFLINE',
      };
      for (const room of roomsForScope(scopes.get(item.vehicle_id) || {})) queue(room, item);
    }
  }

  async function onDetected({ assignmentIds, pidStatusChanges }) {
    if (!assignmentIds?.length) return;
    // ONE query: each assignment's scope + updated counts.
    const { rows } = await db.query(
      `SELECT ra.id AS route_assignment_id, ra.vehicle_id, r.zone_id, r.ward_id, ra.agency_id, ra.assigned_pid_count AS assigned,
              c.confirmed, c.candidate, c.unavailable
         FROM route_assignments ra JOIN routes r ON r.id = ra.route_id
         CROSS JOIN LATERAL (
           SELECT count(*) FILTER (WHERE s.visit_status = 'GPS_VISIT_CONFIRMED')::int AS confirmed,
                  count(*) FILTER (WHERE s.visit_status = 'GPS_VISIT_CANDIDATE')::int AS candidate,
                  count(*) FILTER (WHERE s.visit_status = 'GPS_DATA_UNAVAILABLE')::int AS unavailable
             FROM pid_daily_status s WHERE s.route_assignment_id = ra.id) c
        WHERE ra.id = ANY($1::bigint[])`, [assignmentIds]);
    const perRoom = new Map();
    for (const a of rows) {
      const changes = pidStatusChanges.filter((c) => Number(c.route_assignment_id) === Number(a.route_assignment_id));
      const { zone_id: z, ward_id: w, agency_id: ag, ...counts } = a;
      for (const room of roomsForScope({ zone_id: z, ward_id: w, agency_id: ag })) {
        if (!perRoom.has(room)) perRoom.set(room, { changes: [], assignments: [] });
        perRoom.get(room).changes.push(...changes);
        perRoom.get(room).assignments.push({ ...counts, route_assignment_id: Number(counts.route_assignment_id) });
      }
    }
    for (const [room, payload] of perRoom) io.to(room).emit('pid:status', payload);
  }

  let lastProviderState = null;
  async function onPoll({ provider }) {
    const s = await providerStatus(provider, { executor: db });
    if (s.state !== lastProviderState) {
      lastProviderState = s.state;
      io.emit('provider:status', { provider: s.provider, state: s.state, reason: s.reason, last_success_at: s.last_success_at });
    }
  }

  const safe = (fn, name) => (e) => fn(e).catch((err) => logger.warn({ err: err.message }, `realtime ${name} failed`));
  const handlers = { ingested: safe(onIngested, 'ingested'), detected: safe(onDetected, 'detected'), poll: safe(onPoll, 'poll') };
  for (const [ev, h] of Object.entries(handlers)) events.on(ev, h);
  const recheckTimer = setInterval(() => recheckUsers().catch(() => {}), recheckMs);
  recheckTimer.unref?.();

  return {
    io,
    recheckUsers,
    async close() {
      for (const [ev, h] of Object.entries(handlers)) events.off(ev, h);
      clearInterval(recheckTimer);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      await new Promise((r) => io.close(() => r()));
    },
  };
}
