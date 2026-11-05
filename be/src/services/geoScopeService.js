// Shared zone/ward consistency check (the DB enforces it too via composite FKs — C1 —
// but this gives a clear 422 message instead of a constraint name).
import { unprocessable } from '../utils/errors.js';

/**
 * Resolve the final {zone_id, ward_id} for a record and ensure the ward belongs to the zone.
 * - ward given, zone omitted  -> zone is derived from the ward
 * - both given and mismatched -> 422
 * Mutates and returns `data`.
 */
export async function resolveZoneWard(data, existing, tx) {
  const zoneId = data.zone_id !== undefined ? data.zone_id : existing?.zone_id ?? null;
  const wardId = data.ward_id !== undefined ? data.ward_id : existing?.ward_id ?? null;
  if (wardId === null || wardId === undefined) return data;

  const { rows } = await tx.query('SELECT id, zone_id FROM wards WHERE id = $1', [wardId]);
  if (!rows.length) throw unprocessable('Ward does not exist', [{ field: 'ward_id', message: 'Unknown ward' }]);
  const wardZone = rows[0].zone_id;

  if (zoneId === null || zoneId === undefined) {
    data.zone_id = wardZone;
  } else if (Number(zoneId) !== Number(wardZone)) {
    throw unprocessable('Ward does not belong to the selected zone', [
      { field: 'ward_id', message: `Ward ${wardId} belongs to zone ${wardZone}, not zone ${zoneId}` },
    ]);
  }
  return data;
}
