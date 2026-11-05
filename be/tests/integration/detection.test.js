// PID visit detection scenarios (GUIDE #7 H2). Each scenario has its own vehicle + assignment.
import { describe, it, expect } from 'vitest';
import { pool } from '../../src/config/database.js';
import { gpsEvents } from '../../src/services/gps/gpsEvents.js';
import { detectBatch } from '../../src/services/pidDetectionService.js';
import { loadDetectionSettings } from '../../src/services/settingsDefinitions.js';
import { finalizeDue, reprocess } from '../../src/services/coverageFinalizationService.js';
import { PidVisitWorker, detectLockKeyFor } from '../../src/jobs/pidVisitProcessingJob.js';
import { createAdvisoryLock } from '../../src/jobs/gpsPollingJob.js';
import { todayInTz, addDays } from '../../src/utils/time.js';
import { createVehicle, createUser, uid } from '../helpers/fixtures.js';
import { ORIGIN, at, ist, makeAssignment, track, detect, statuses, events, BASE } from '../helpers/detection.js';

// Future dates: the finalizer (scenario 15) only touches windows that closed in the past.
let dayN = 40;
const futureDay = () => addDays(todayInTz('Asia/Kolkata'), dayN++);
const P = ORIGIN;

describe('detection scenarios', () => {
  it('1. a single drive-by point -> CANDIDATE', async () => {
    const d = futureDay();
    const { raId, pidIds, vehicle } = await makeAssignment({ pids: [P], date: d });
    await track(vehicle.id, [{ p: at(10), t: ist(d, '09:00:00') }]);
    await detect();
    expect((await statuses(raId))[pidIds[0]]).toMatchObject({ visit_status: 'GPS_VISIT_CANDIDATE', detection_count: 1 });
    const ra = (await pool.query('SELECT status FROM route_assignments WHERE id = $1', [raId])).rows[0];
    expect(ra.status).toBe('ACTIVE'); // first point activates a PLANNED assignment
  });

  it('2. two adjacent points within radius -> CONFIRMED', async () => {
    const d = futureDay();
    const { raId, pidIds, vehicle } = await makeAssignment({ pids: [P], date: d });
    await track(vehicle.id, [{ p: at(10), t: ist(d, '09:00:00') }, { p: at(-12), t: ist(d, '09:00:20') }]);
    await detect();
    const s = (await statuses(raId))[pidIds[0]];
    expect(s).toMatchObject({ visit_status: 'GPS_VISIT_CONFIRMED', detection_count: 2 });
    expect(s.confirmed_at).not.toBeNull();
    expect(s.min_distance_meters).toBeCloseTo(10, 0);
  });

  it('3. in-radius points with an out-of-radius point between them -> CANDIDATE (not adjacent)', async () => {
    const d = futureDay();
    const { raId, pidIds, vehicle } = await makeAssignment({ pids: [P], date: d });
    await track(vehicle.id, [
      { p: at(10), t: ist(d, '09:00:00') }, { p: at(200), t: ist(d, '09:00:30') }, { p: at(8), t: ist(d, '09:01:00') }]);
    await detect();
    expect((await statuses(raId))[pidIds[0]]).toMatchObject({ visit_status: 'GPS_VISIT_CANDIDATE', detection_count: 2 });
  });

  it('4. a parallel road 40 m away -> NOT_VISITED, no events', async () => {
    const d = futureDay();
    const { raId, pidIds, vehicle } = await makeAssignment({ pids: [P], date: d });
    await track(vehicle.id, [-60, -30, 0, 30, 60].map((e, i) => ({ p: at(40, e), t: ist(d, `09:00:${String(i * 10).padStart(2, '0')}`) })));
    await detect();
    expect((await statuses(raId))[pidIds[0]].visit_status).toBe('NOT_VISITED');
    expect(await events(raId)).toHaveLength(0);
  });

  it('5. stationary near the PID for 3 min -> CONFIRMED under dwell and under consecutive_points', async () => {
    const pts = (d) => Array.from({ length: 7 }, (_, i) => ({ p: at(5 + (i % 2), 1), t: ist(d, `09:0${Math.floor((i * 30) / 60)}:${String((i * 30) % 60).padStart(2, '0')}`), speed: 0 }));
    const d1 = futureDay();
    const a = await makeAssignment({ pids: [P], date: d1 });
    await track(a.vehicle.id, pts(d1));
    await detect({ confirmationMode: 'dwell', minDwellSeconds: 120 });
    expect((await statuses(a.raId))[a.pidIds[0]].visit_status).toBe('GPS_VISIT_CONFIRMED');

    const d2 = futureDay();
    const b = await makeAssignment({ pids: [P], date: d2 });
    await track(b.vehicle.id, pts(d2));
    await detect({ confirmationMode: 'consecutive_points' });
    expect((await statuses(b.raId))[b.pidIds[0]].visit_status).toBe('GPS_VISIT_CONFIRMED');

    // dwell needs the span: two adjacent points 30 s apart are NOT enough for a 120 s dwell
    const d3 = futureDay();
    const c = await makeAssignment({ pids: [P], date: d3 });
    await track(c.vehicle.id, pts(d3).slice(0, 2));
    await detect({ confirmationMode: 'dwell', minDwellSeconds: 120 });
    expect((await statuses(c.raId))[c.pidIds[0]].visit_status).toBe('GPS_VISIT_CANDIDATE');
  });

  it('6. over max speed -> REJECTED_SPEED events and no status change', async () => {
    const d = futureDay();
    const { raId, pidIds, vehicle } = await makeAssignment({ pids: [P], date: d });
    await track(vehicle.id, [{ p: at(5), t: ist(d, '09:00:00'), speed: 80 }, { p: at(-5), t: ist(d, '09:00:05'), speed: 82 }]);
    const r = await detect({ maxSpeedKmh: 60 });
    expect(r.rejected_points).toBeGreaterThanOrEqual(2);
    expect((await events(raId)).map((e) => e.evidence_status)).toEqual(['REJECTED_SPEED', 'REJECTED_SPEED']);
    expect((await statuses(raId))[pidIds[0]]).toMatchObject({ visit_status: 'NOT_VISITED', detection_count: 0 });
  });

  it('7. stale points: evidence_only -> REJECTED_STALE (no confirmation); accept -> normal', async () => {
    const stale = (d) => [{ p: at(5), t: ist(d, '09:00:00'), delayS: 1200 }, { p: at(-5), t: ist(d, '09:00:20'), delayS: 1180 }];
    const d1 = futureDay();
    const a = await makeAssignment({ pids: [P], date: d1 });
    await track(a.vehicle.id, stale(d1));
    await detect({ latePointsPolicy: 'evidence_only', maxGpsAgeS: 300 });
    expect((await events(a.raId)).every((e) => e.evidence_status === 'REJECTED_STALE')).toBe(true);
    expect((await statuses(a.raId))[a.pidIds[0]].visit_status).toBe('NOT_VISITED');

    const d2 = futureDay();
    const b = await makeAssignment({ pids: [P], date: d2 });
    await track(b.vehicle.id, stale(d2));
    await detect({ latePointsPolicy: 'accept', maxGpsAgeS: 300 });
    expect((await statuses(b.raId))[b.pidIds[0]].visit_status).toBe('GPS_VISIT_CONFIRMED');
  });

  it('8. an out-of-order late point that completes an adjacency pair -> CANDIDATE then CONFIRMED', async () => {
    const d = futureDay();
    const { raId, pidIds, vehicle } = await makeAssignment({ pids: [P], date: d });
    await track(vehicle.id, [{ p: at(10), t: ist(d, '09:00:00') }, { p: at(300), t: ist(d, '09:01:00') }]);
    await detect();
    expect((await statuses(raId))[pidIds[0]].visit_status).toBe('GPS_VISIT_CANDIDATE');
    // late point recorded BETWEEN the two, inside the radius -> 09:00:00 and 09:00:30 are adjacent
    await track(vehicle.id, [{ p: at(-6), t: ist(d, '09:00:30'), delayS: 60 }]);
    await detect();
    expect((await statuses(raId))[pidIds[0]]).toMatchObject({ visit_status: 'GPS_VISIT_CONFIRMED', detection_count: 2 });
  });

  it('9. processing the same batch twice / running the worker twice -> identical rows', async () => {
    const d = futureDay();
    const { raId, vehicle } = await makeAssignment({ pids: [P, at(15, 15)], date: d });
    const ids = await track(vehicle.id, [{ p: at(5), t: ist(d, '09:00:00') }, { p: at(10, 10), t: ist(d, '09:00:15') }, { p: at(400), t: ist(d, '09:00:45') }]);
    await detect();
    const before = { s: await statuses(raId), e: await events(raId) };
    await pool.query('UPDATE gps_locations SET processed_at = NULL WHERE id = ANY($1)', [ids]); // replay the same batch
    await detect();
    await detect(); // second "worker run": nothing left
    expect(await statuses(raId)).toEqual(before.s);
    expect(await events(raId)).toEqual(before.e);
  });

  it('10. one point near 3 PIDs -> ambiguous, pids_in_radius = 3', async () => {
    const d = futureDay();
    const { raId, pidIds, vehicle } = await makeAssignment({ pids: [at(10, 0), at(-10, 0), at(0, 15)], date: d });
    await track(vehicle.id, [{ p: P, t: ist(d, '09:00:00') }]);
    await detect();
    const ev = await events(raId);
    expect(ev).toHaveLength(3);
    expect(ev.every((e) => e.ambiguous && e.pids_in_radius === 3)).toBe(true);
    const s = await statuses(raId);
    expect(pidIds.every((id) => s[id].ambiguous && s[id].visit_status === 'GPS_VISIT_CANDIDATE')).toBe(true);
  });

  it('11. same PID on two assignments (vehicle reassigned mid-day) -> statuses go to the right assignment', async () => {
    const d = futureDay();
    const v = await createVehicle();
    const a1 = await makeAssignment({ pids: [P], date: d, vehicle: v, shift: [ist(d, '06:00:00'), ist(d, '10:00:00')] });
    const a2 = await makeAssignment({ pids: [], date: d, vehicle: v, routeWard: a1.zw, existingPidIds: a1.pidIds, shift: [ist(d, '10:00:00'), ist(d, '14:00:00')] });
    await track(v.id, [{ p: at(5), t: ist(d, '08:00:00') }, { p: at(-5), t: ist(d, '08:00:20') }]);
    await detect();
    expect((await statuses(a1.raId))[a1.pidIds[0]].visit_status).toBe('GPS_VISIT_CONFIRMED');
    expect((await statuses(a2.raId))[a1.pidIds[0]].visit_status).toBe('NOT_VISITED');
    await track(v.id, [{ p: at(7), t: ist(d, '11:00:00') }]);
    await detect();
    expect((await statuses(a2.raId))[a1.pidIds[0]].visit_status).toBe('GPS_VISIT_CANDIDATE');
  });

  it('12. midnight-crossing shift: 01:00 IST next day goes to the night assignment, not the next day all-day one', async () => {
    const d = futureDay();
    const d1 = addDays(d, 1);
    const v = await createVehicle();
    const night = await makeAssignment({ pids: [P], date: d, vehicle: v, shift: [ist(d, '22:00:00'), ist(d1, '04:00:00')] });
    const allDay = await makeAssignment({ pids: [], date: d1, vehicle: v, routeWard: night.zw, existingPidIds: night.pidIds });
    await track(v.id, [{ p: at(5), t: ist(d1, '01:00:00') }, { p: at(-5), t: ist(d1, '01:00:20') }, { p: at(5), t: ist(d1, '09:00:00') }]);
    await detect();
    expect((await statuses(night.raId))[night.pidIds[0]].visit_status).toBe('GPS_VISIT_CONFIRMED');
    expect((await statuses(allDay.raId))[night.pidIds[0]].visit_status).toBe('GPS_VISIT_CANDIDATE'); // only the 09:00 point
  });

  it('13. a point without any assignment is processed, with no events', async () => {
    const v = await createVehicle();
    const ids = await track(v.id, [{ p: P, t: ist(futureDay(), '09:00:00') }]);
    const r = await detect();
    expect(r.unassigned_points).toBeGreaterThanOrEqual(1);
    const g = (await pool.query('SELECT processed_at FROM gps_locations WHERE id = $1', [ids[0]])).rows[0];
    expect(g.processed_at).not.toBeNull();
    expect((await pool.query('SELECT count(*)::int n FROM pid_visit_events WHERE gps_location_id = $1', [ids[0]])).rows[0].n).toBe(0);
  });

  it('14. a snapshot PID with NULL coordinates is ignored (even if the master PID has coordinates now)', async () => {
    const d = futureDay();
    const { raId, pidIds, vehicle } = await makeAssignment({ pids: [null], date: d });
    await pool.query('UPDATE pids SET latitude = $2, longitude = $3, coord_status = $4 WHERE id = $1', [pidIds[0], P[0], P[1], 'MANUALLY_CORRECTED']);
    await track(vehicle.id, [{ p: P, t: ist(d, '09:00:00') }, { p: P, t: ist(d, '09:00:10') }]);
    await detect();
    expect(await events(raId)).toHaveLength(0);
    expect((await statuses(raId))[pidIds[0]].visit_status).toBe('GPS_DATA_UNAVAILABLE');
  });

  it('15. finalization: no data -> GPS_DATA_UNAVAILABLE, with data -> NOT_VISITED kept, idempotent, late data upgrades', async () => {
    const past = addDays(todayInTz('Asia/Kolkata'), -5);
    const empty = await makeAssignment({ pids: [P, at(500)], date: past });
    const withData = await makeAssignment({ pids: [P], date: past });
    await track(withData.vehicle.id, [{ p: at(800), t: ist(past, '09:00:00') }]); // data, but not near the PID
    await detect();
    const settings = await loadDetectionSettings(pool);
    const r1 = await finalizeDue(pool, settings, { emit: false });
    expect(r1.finalized).toBeGreaterThanOrEqual(2);
    expect(Object.values(await statuses(empty.raId)).map((s) => s.visit_status)).toEqual(['GPS_DATA_UNAVAILABLE', 'GPS_DATA_UNAVAILABLE']);
    expect((await statuses(withData.raId))[withData.pidIds[0]].visit_status).toBe('NOT_VISITED');
    const ras = (await pool.query('SELECT id, status, finalized_at FROM route_assignments WHERE id = ANY($1)', [[empty.raId, withData.raId]])).rows;
    expect(ras.every((x) => x.status === 'COMPLETED' && x.finalized_at)).toBe(true);

    const r2 = await finalizeDue(pool, settings, { emit: false });
    expect(await statuses(empty.raId)).toEqual(await statuses(empty.raId)); // unchanged
    expect(r2.status_changes).toBe(0);

    // late data for the finalized empty assignment: upgrades + LATE_DATA_AFTER_FINALIZE
    await track(empty.vehicle.id, [{ p: at(4), t: ist(past, '10:00:00'), delayS: 4 * 86_400 }]);
    await detect({ latePointsPolicy: 'accept' });
    expect((await statuses(empty.raId))[empty.pidIds[0]].visit_status).toBe('GPS_VISIT_CANDIDATE');
    const log = await pool.query("SELECT 1 FROM activity_logs WHERE action = 'LATE_DATA_AFTER_FINALIZE' AND reference_id = $1", [String(empty.raId)]);
    expect(log.rowCount).toBe(1);
  });

  it('16. reprocess after a radius change (30 -> 50) gives new statuses; raw points untouched', async () => {
    const d = futureDay();
    const { raId, pidIds, vehicle } = await makeAssignment({ pids: [P], date: d });
    await track(vehicle.id, [{ p: at(40), t: ist(d, '09:00:00') }, { p: at(42, 3), t: ist(d, '09:00:20') }]);
    await detect({ radiusM: 30 });
    expect((await statuses(raId))[pidIds[0]].visit_status).toBe('NOT_VISITED');
    const rawBefore = (await pool.query('SELECT count(*)::int n FROM gps_locations WHERE vehicle_id = $1', [vehicle.id])).rows[0].n;

    const admin = await createUser('SUPER_ADMIN');
    const settings = await loadDetectionSettings(pool, { ...BASE, radiusM: 50 });
    const r = await reprocess({ route_assignment_id: raId }, settings, { user: admin.user, scope: { unrestricted: true } }, pool);
    expect(r.results[0]).toMatchObject({ route_assignment_id: raId, points_requeued: 2 });
    await detect({ radiusM: 50 });
    expect((await statuses(raId))[pidIds[0]].visit_status).toBe('GPS_VISIT_CONFIRMED');
    expect((await pool.query('SELECT count(*)::int n FROM gps_locations WHERE vehicle_id = $1', [vehicle.id])).rows[0].n).toBe(rawBefore);
    const audit = await pool.query("SELECT details FROM activity_logs WHERE action = 'REPROCESS' AND reference_id = $1", [String(raId)]);
    expect(audit.rows[0].details.settings.radiusM).toBe(50);
  });

  it('17. detection.enabled=false leaves the backlog; re-enabling drains it', async () => {
    const d = futureDay();
    const { raId, pidIds, vehicle } = await makeAssignment({ pids: [P], date: d });
    const ids = await track(vehicle.id, [{ p: at(3), t: ist(d, '09:00:00') }, { p: at(4), t: ist(d, '09:00:10') }]);
    const r = await detect({ enabled: false });
    expect(r.skipped).toMatch(/enabled=false/);
    expect((await pool.query('SELECT count(*)::int n FROM gps_locations WHERE id = ANY($1) AND processed_at IS NULL', [ids])).rows[0].n).toBe(2);
    await detect({ enabled: true });
    expect((await statuses(raId))[pidIds[0]].visit_status).toBe('GPS_VISIT_CONFIRMED');
  });

  it('18. two workers: only one holds the lock; concurrent batches never double-process (SKIP LOCKED)', async () => {
    const key = `${detectLockKeyFor()}:t18:${uid()}`;
    const w1 = new PidVisitWorker({ lock: createAdvisoryLock({ keyText: key }), logger: { info() {}, warn() {}, error() {} } });
    const w2 = new PidVisitWorker({ lock: createAdvisoryLock({ keyText: key }), logger: { info() {}, warn() {}, error() {} } });
    try {
      await w1.start();
      await w2.start();
      expect(w1.isLeader).toBe(true);
      expect(w2.isLeader).toBe(false);
    } finally {
      await w1.stop();
      await w2.stop();
    }

    const d = futureDay();
    const { raId, vehicle } = await makeAssignment({ pids: [P], date: d });
    const pts = Array.from({ length: 40 }, (_, i) => ({ p: at(i % 2 ? 4 : -4), t: new Date(ist(d, '09:00:00').getTime() + i * 5000) }));
    await track(vehicle.id, pts);
    const settings = await loadDetectionSettings(pool, BASE);
    const [a, b] = await Promise.all([detectBatch(pool, settings, { batchSize: 25 }), detectBatch(pool, settings, { batchSize: 25 })]);
    const claimed = (a?.points ?? 0) + (b?.points ?? 0);
    await detect();
    const ev = await events(raId);
    expect(new Set(ev.map((e) => e.gps_location_id)).size).toBe(ev.length); // no duplicate evidence
    expect(ev).toHaveLength(40);
    expect(claimed).toBeGreaterThan(0);
  });

  it('19. the detected event lists only pairs whose status changed', async () => {
    const d = futureDay();
    const { raId, pidIds, vehicle } = await makeAssignment({ pids: [P, at(500)], date: d });
    const got = [];
    const on = (e) => got.push(e);
    gpsEvents.on('detected', on);
    try {
      await track(vehicle.id, [{ p: at(5), t: ist(d, '09:00:00') }]);
      await detect();
      await track(vehicle.id, [{ p: at(6), t: ist(d, '09:05:00') }]); // adjacent to 09:00 (no point between) -> CONFIRMED
      await detect();
      await track(vehicle.id, [{ p: at(7), t: ist(d, '09:10:00') }]); // CONFIRMED stays CONFIRMED -> no change emitted
      await detect();
    } finally {
      gpsEvents.off('detected', on);
    }
    const mine = got.flatMap((e) => e.pidStatusChanges).filter((c) => c.route_assignment_id === raId);
    expect(mine).toEqual([
      { route_assignment_id: raId, pid_id: pidIds[0], old_status: 'NOT_VISITED', new_status: 'GPS_VISIT_CANDIDATE' },
      { route_assignment_id: raId, pid_id: pidIds[0], old_status: 'GPS_VISIT_CANDIDATE', new_status: 'GPS_VISIT_CONFIRMED' },
    ]);
  });

  it('min_events mode: N valid events within the window (non-adjacent allowed)', async () => {
    const d = futureDay();
    const { raId, pidIds, vehicle } = await makeAssignment({ pids: [P], date: d });
    await track(vehicle.id, [{ p: at(5), t: ist(d, '09:00:00') }, { p: at(300), t: ist(d, '09:01:00') }, { p: at(6), t: ist(d, '09:02:00') }]);
    await detect({ confirmationMode: 'min_events', consecutivePoints: 2, confirmationWindowS: 300 });
    expect((await statuses(raId))[pidIds[0]].visit_status).toBe('GPS_VISIT_CONFIRMED');
  });
});

describe('round trips per detection batch', () => {
  it('a batch costs ≤ 5 round trips (BEGIN, claim+detect, recompute, COMMIT = 4)', async () => {
    const d = futureDay();
    const { vehicle } = await makeAssignment({ pids: [P, at(20, 20), at(-20, 10)], date: d });
    await track(vehicle.id, Array.from({ length: 50 }, (_, i) => ({ p: at((i % 10) * 3, i % 7), t: new Date(ist(d, '09:00:00').getTime() + i * 10_000) })));
    await detect(); // flush anything else first
    await pool.query('UPDATE gps_locations SET processed_at = NULL WHERE vehicle_id = $1', [vehicle.id]);
    let n = 0;
    const settings = await loadDetectionSettings(pool, BASE);
    const r = await detectBatch(pool, settings, { countQuery: () => { n++; } });
    expect(r.points).toBe(50);
    expect(n).toBeLessThanOrEqual(5);
    expect(n).toBe(4);
  });
});
