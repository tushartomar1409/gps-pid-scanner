import { MasterListPage } from './MasterListPage.jsx';
import { ZoneWardSelects } from './ZoneWardSelects.jsx';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { useFormState, idOrNull, textOrNull, str } from '../../hooks/useFormState.js';
import { toOptions } from '../../hooks/useLookups.js';
import { vehiclesApi } from '../../api/resources.js';

export const VEHICLE_STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
  { value: 'INACTIVE', label: 'Inactive' },
];

export const normaliseVehicleNumber = (v) => v.toUpperCase().replace(/\s+/g, '');

function VehicleForm({ formId, initial, isEdit, lookups, serverErrors, onSubmit }) {
  const { values, setField, errorFor, handleSubmit } = useFormState(
    {
      vehicle_number: initial.vehicle_number ?? '',
      vehicle_type: initial.vehicle_type ?? '',
      gps_device_id: initial.gps_device_id ?? '',
      gps_provider: initial.gps_provider ?? '',
      agency_id: str(initial.agency_id),
      zone_id: str(initial.zone_id),
      ward_id: str(initial.ward_id),
      status: initial.status ?? 'ACTIVE',
    },
    {
      validate: (v) => {
        const num = normaliseVehicleNumber(v.vehicle_number);
        return {
          vehicle_number: !num ? 'Vehicle number is required' : !/^[A-Z0-9-]{4,20}$/.test(num) ? '4–20 letters, digits or -' : null,
          vehicle_type: !v.vehicle_type.trim() ? 'Vehicle type is required' : null,
          gps_device_id: v.gps_device_id.trim().length > 64 ? 'Max 64 characters' : null,
        };
      },
      toPayload: (v) => ({
        vehicle_number: normaliseVehicleNumber(v.vehicle_number),
        vehicle_type: v.vehicle_type.trim(),
        gps_device_id: textOrNull(v.gps_device_id),
        gps_provider: textOrNull(v.gps_provider),
        agency_id: idOrNull(v.agency_id),
        zone_id: idOrNull(v.zone_id),
        ward_id: idOrNull(v.ward_id),
        ...(isEdit ? { status: v.status } : {}),
      }),
      onSubmit,
      serverErrors,
    },
  );

  return (
    <form id={formId} onSubmit={handleSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
      <Input
        label="Vehicle number"
        required
        value={values.vehicle_number}
        onChange={(e) => setField('vehicle_number', e.target.value)}
        error={errorFor('vehicle_number')}
        hint={values.vehicle_number ? `Saved as ${normaliseVehicleNumber(values.vehicle_number)}` : 'e.g. HR38AB1234'}
      />
      <Input label="Vehicle type" required value={values.vehicle_type} onChange={(e) => setField('vehicle_type', e.target.value)} error={errorFor('vehicle_type')} placeholder="Tipper, Compactor…" />
      <Input label="GPS device ID" value={values.gps_device_id} onChange={(e) => setField('gps_device_id', e.target.value)} error={errorFor('gps_device_id')} />
      <Input label="GPS provider" value={values.gps_provider} onChange={(e) => setField('gps_provider', e.target.value)} error={errorFor('gps_provider')} />
      <div className="sm:col-span-2">
        <Select label="Agency" placeholder="No agency" value={values.agency_id} options={toOptions(lookups.agencies)} fallbackLabel={initial.agency_name} onChange={(e) => setField('agency_id', e.target.value)} error={errorFor('agency_id')} />
      </div>
      <ZoneWardSelects values={values} setField={setField} errorFor={errorFor} lookups={lookups} initial={initial} />
      {isEdit && <Select label="Status" value={values.status} options={VEHICLE_STATUS_OPTIONS} onChange={(e) => setField('status', e.target.value)} />}
    </form>
  );
}

const config = {
  title: 'Vehicles',
  description: 'Collection vehicles and their GPS device mapping.',
  singular: 'Vehicle',
  permission: 'vehicles',
  labelKey: 'vehicle_number',
  api: vehiclesApi,
  lookupTypes: ['zones', 'wards', 'agencies'],
  searchPlaceholder: 'Vehicle no., GPS device, type',
  filters: [
    { key: 'zone_id', label: 'Zone', type: 'select', options: (l) => toOptions(l.zones) },
    {
      key: 'ward_id',
      label: 'Ward',
      type: 'select',
      dependsOn: 'zone_id',
      options: (l, p) => toOptions((l.wards || []).filter((w) => !p.zone_id || String(w.zone_id) === p.zone_id)),
    },
    { key: 'agency_id', label: 'Agency', type: 'select', options: (l) => toOptions(l.agencies) },
    { key: 'vehicle_type', label: 'Vehicle type', type: 'text' },
    { key: 'status', label: 'Status', type: 'select', options: () => VEHICLE_STATUS_OPTIONS },
  ],
  columns: [
    { key: 'vehicle_number', header: 'Vehicle no.', render: (r) => <span className="font-mono text-xs font-semibold">{r.vehicle_number}</span> },
    { key: 'vehicle_type', header: 'Type' },
    { key: 'gps_device_id', header: 'GPS device' },
    { key: 'agency_name', header: 'Agency' },
    { key: 'zone_name', header: 'Zone' },
    { key: 'ward_name', header: 'Ward' },
  ],
  Form: VehicleForm,
  conflictMessages: {
    vehicles_vehicle_number_key: 'Vehicle number already exists',
    vehicles_gps_device_id_key: 'This GPS device ID is already linked to another vehicle',
  },
};

export default function VehiclesPage() {
  return <MasterListPage config={config} />;
}
