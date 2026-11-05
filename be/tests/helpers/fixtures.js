// Test data builders. Unique suffixes keep tests independent inside the shared test schema.
import crypto from 'node:crypto';
import { pool } from '../../src/config/database.js';
import { hashPassword } from '../../src/services/passwordService.js';
import { signToken } from '../../src/services/tokenService.js';

export const uid = () => crypto.randomBytes(4).toString('hex').toUpperCase();

export async function createZone(overrides = {}) {
  const s = uid();
  const { rows } = await pool.query(
    'INSERT INTO zones (zone_code, zone_name) VALUES ($1, $2) RETURNING *',
    [overrides.zone_code ?? `Z${s}`, overrides.zone_name ?? `Zone ${s}`],
  );
  return rows[0];
}

export async function createWard(zoneId, overrides = {}) {
  const s = uid();
  const { rows } = await pool.query(
    'INSERT INTO wards (zone_id, ward_number, ward_name) VALUES ($1, $2, $3) RETURNING *',
    [zoneId, overrides.ward_number ?? `W${s}`, overrides.ward_name ?? `Ward ${s}`],
  );
  return rows[0];
}

export async function createAgency(overrides = {}) {
  const s = uid();
  const { rows } = await pool.query(
    'INSERT INTO agencies (agency_name) VALUES ($1) RETURNING *',
    [overrides.agency_name ?? `Agency ${s}`],
  );
  return rows[0];
}

export async function createVehicle({ agency_id = null, zone_id = null, ward_id = null, ...rest } = {}) {
  const s = uid();
  const { rows } = await pool.query(
    `INSERT INTO vehicles (vehicle_number, vehicle_type, gps_device_id, agency_id, zone_id, ward_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [rest.vehicle_number ?? `HR38${s}`, rest.vehicle_type ?? 'TIPPER', rest.gps_device_id ?? `GPS${s}`,
      agency_id, zone_id, ward_id],
  );
  return rows[0];
}

/** Create a user directly; returns { user, password, token }. */
export async function createUser(roleKey, { zone_id = null, ward_id = null, agency_id = null, status = 'ACTIVE', password } = {}) {
  const s = uid().toLowerCase();
  const plain = password ?? `Passw0rd-${s}`;
  const role = await pool.query('SELECT id FROM roles WHERE role_key = $1', [roleKey]);
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role_id, zone_id, ward_id, agency_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, email, zone_id, ward_id, agency_id`,
    [`${roleKey} ${s}`, `${roleKey.toLowerCase()}.${s}@test.local`, await hashPassword(plain),
      role.rows[0].id, zone_id, ward_id, agency_id, status],
  );
  const user = { ...rows[0], role_key: roleKey };
  return { user, password: plain, token: signToken(user) };
}

export const bearer = (token) => ({ Authorization: `Bearer ${token}` });

/** Zone + ward pair in one call. */
export async function createZoneWard() {
  const zone = await createZone();
  const ward = await createWard(zone.id);
  return { zone, ward };
}

export async function createPid({ zone_id, ward_id, latitude = null, longitude = null, status = 'ACTIVE', pid_number } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pids (pid_number, zone_id, ward_id, latitude, longitude, coord_status, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [pid_number ?? `PID${uid()}`, zone_id, ward_id, latitude, longitude, latitude === null ? 'MISSING' : 'IMPORTED', status],
  );
  return rows[0];
}

export async function createRoute({ zone_id, ward_id, agency_id = null, status = 'ACTIVE', route_code } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO routes (route_code, route_name, zone_id, ward_id, agency_id, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [route_code ?? `R${uid()}`, 'Test route', zone_id, ward_id, agency_id, status],
  );
  return rows[0];
}

export async function addRoutePids(routeId, pidIds) {
  await pool.query(
    `INSERT INTO route_pids (route_id, pid_id, sequence_no)
     SELECT $1, t.id, t.ord FROM unnest($2::bigint[]) WITH ORDINALITY AS t(id, ord)`,
    [routeId, pidIds],
  );
}

/** Route in a fresh zone/ward with `n` PIDs (coordinates unless `withoutCoords` lists indexes). */
export async function createRouteWithPids(n, { agency_id = null, withoutCoords = [] } = {}) {
  const { zone, ward } = await createZoneWard();
  const route = await createRoute({ zone_id: zone.id, ward_id: ward.id, agency_id });
  const pids = [];
  for (let i = 0; i < n; i++) {
    // Area (26.x, 75.x) kept apart from coordinates used by the import tests (28.x, 77.x).
    const coords = withoutCoords.includes(i) ? {} : { latitude: 26.1 + Math.random() * 0.5, longitude: 75.1 + Math.random() * 0.5 };
    // eslint-disable-next-line no-await-in-loop
    pids.push(await createPid({ zone_id: zone.id, ward_id: ward.id, ...coords }));
  }
  await addRoutePids(route.id, pids.map((p) => p.id));
  return { zone, ward, route, pids };
}
