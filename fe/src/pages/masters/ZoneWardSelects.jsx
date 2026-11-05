// Zone + dependent Ward selects. Ward options are limited to the selected zone; changing the zone
// clears a ward that no longer belongs; picking a ward with no zone fills the zone in.
import { Select } from '../../components/Select.jsx';
import { toOptions } from '../../hooks/useLookups.js';

export function ZoneWardSelects({ values, setField, errorFor, lookups, initial = {}, zoneRequired, wardRequired, showZone = true, showWard = true }) {
  const wards = lookups.wards || [];
  const wardOptions = toOptions(values.zone_id ? wards.filter((w) => String(w.zone_id) === String(values.zone_id)) : wards);

  const onZone = (zoneId) => {
    setField('zone_id', zoneId);
    const ward = wards.find((w) => String(w.id) === String(values.ward_id));
    if (values.ward_id && (!zoneId || !ward || String(ward.zone_id) !== String(zoneId))) setField('ward_id', '');
  };
  const onWard = (wardId) => {
    setField('ward_id', wardId);
    const ward = wards.find((w) => String(w.id) === String(wardId));
    if (ward && !values.zone_id) setField('zone_id', String(ward.zone_id));
  };

  return (
    <>
      {showZone && (
        <Select
          label="Zone"
          required={zoneRequired}
          placeholder="Select zone"
          value={values.zone_id}
          options={toOptions(lookups.zones)}
          fallbackLabel={initial.zone_name}
          onChange={(e) => onZone(e.target.value)}
          error={errorFor('zone_id')}
        />
      )}
      {showWard && (
        <Select
          label="Ward"
          required={wardRequired}
          placeholder={values.zone_id || !showZone ? 'Select ward' : 'Select zone first or pick any ward'}
          value={values.ward_id}
          options={wardOptions}
          fallbackLabel={initial.ward_name}
          onChange={(e) => onWard(e.target.value)}
          error={errorFor('ward_id')}
        />
      )}
    </>
  );
}
