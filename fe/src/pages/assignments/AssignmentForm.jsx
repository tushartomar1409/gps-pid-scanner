import { useState } from 'react';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { toOptions } from '../../hooks/useLookups.js';
import { buildShiftIso, todayIST } from '../../utils/dates.js';

/**
 * Create-assignment form. Route list filtered by zone/ward, vehicle list by agency.
 * Shift times are IST (HH:mm); sent as ISO strings with an explicit +05:30 offset.
 */
export function AssignmentForm({ formId, lookups, defaultDate, serverErrors = {}, onSubmit }) {
  const [v, setV] = useState({
    operational_date: defaultDate || todayIST(),
    zone_id: '', ward_id: '', route_id: '', agency_id: '', vehicle_id: '', start: '', end: '',
  });
  const [errors, setErrors] = useState({});
  const set = (k, val) => {
    setErrors((e) => ({ ...e, [k]: undefined }));
    setV((s) => {
      const next = { ...s, [k]: val };
      if (k === 'zone_id') next.ward_id = '';
      if (k === 'zone_id' || k === 'ward_id') next.route_id = '';
      if (k === 'agency_id') next.vehicle_id = '';
      return next;
    });
  };

  const routes = (lookups.routes || []).filter(
    (r) => (!v.zone_id || String(r.zone_id) === v.zone_id) && (!v.ward_id || String(r.ward_id) === v.ward_id),
  );
  const vehicles = (lookups.vehicles || []).filter((x) => !v.agency_id || String(x.agency_id) === v.agency_id);
  const shift = buildShiftIso(v.operational_date, v.start, v.end);

  const submit = (e) => {
    e.preventDefault();
    const found = {};
    if (!v.operational_date) found.operational_date = 'Date is required';
    if (!v.route_id) found.route_id = 'Route is required';
    if (!v.vehicle_id) found.vehicle_id = 'Vehicle is required';
    if (shift?.error) found.shift_start = shift.error;
    setErrors(found);
    if (Object.keys(found).length) return;
    onSubmit({
      route_id: Number(v.route_id),
      vehicle_id: Number(v.vehicle_id),
      operational_date: v.operational_date,
      ...(shift ? { shift_start: shift.shift_start, shift_end: shift.shift_end } : {}),
    });
  };
  const err = (k) => errors[k] || serverErrors[k];

  return (
    <form id={formId} onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Input label="Operational date" type="date" required value={v.operational_date} onChange={(e) => set('operational_date', e.target.value)} error={err('operational_date')} />
      </div>
      <Select label="Zone (filter)" placeholder="All zones" value={v.zone_id} options={toOptions(lookups.zones)} onChange={(e) => set('zone_id', e.target.value)} />
      <Select label="Ward (filter)" placeholder="All wards" value={v.ward_id} options={toOptions((lookups.wards || []).filter((w) => !v.zone_id || String(w.zone_id) === v.zone_id))} onChange={(e) => set('ward_id', e.target.value)} />
      <div className="sm:col-span-2">
        <Select label="Route" required placeholder={routes.length ? 'Select route' : 'No active routes match'} value={v.route_id} options={routes.map((r) => ({ value: String(r.id), label: `${r.code} — ${r.name}` }))} onChange={(e) => set('route_id', e.target.value)} error={err('route_id')} />
      </div>
      <Select label="Agency (filter)" placeholder="All agencies" value={v.agency_id} options={toOptions(lookups.agencies)} onChange={(e) => set('agency_id', e.target.value)} />
      <Select label="Vehicle" required placeholder={vehicles.length ? 'Select vehicle' : 'No active vehicles match'} value={v.vehicle_id} options={vehicles.map((x) => ({ value: String(x.id), label: `${x.name}${x.code ? ` (${x.code})` : ''}` }))} onChange={(e) => set('vehicle_id', e.target.value)} error={err('vehicle_id')} />
      <Input label="Shift start (IST)" type="time" value={v.start} onChange={(e) => set('start', e.target.value)} error={err('shift_start')} hint="Leave both empty for an all-day assignment" />
      <Input label="Shift end (IST)" type="time" value={v.end} onChange={(e) => set('end', e.target.value)} error={err('shift_end')} hint={shift?.crossesMidnight ? 'Ends the next day (crosses midnight)' : undefined} />
    </form>
  );
}
