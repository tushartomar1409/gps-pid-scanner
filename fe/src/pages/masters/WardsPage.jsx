import { MasterListPage, STATUS_OPTIONS } from './MasterListPage.jsx';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { useFormState, str } from '../../hooks/useFormState.js';
import { toOptions } from '../../hooks/useLookups.js';
import { wardsApi } from '../../api/resources.js';

function WardForm({ formId, initial, isEdit, lookups, serverErrors, onSubmit }) {
  const { values, setField, errorFor, handleSubmit } = useFormState(
    { zone_id: str(initial.zone_id), ward_number: initial.ward_number ?? '', ward_name: initial.ward_name ?? '', status: initial.status ?? 'ACTIVE' },
    {
      validate: (v) => ({
        zone_id: !v.zone_id ? 'Zone is required' : null,
        ward_number: !v.ward_number.trim() ? 'Ward number is required' : v.ward_number.trim().length > 20 ? 'Max 20 characters' : null,
        ward_name: !v.ward_name.trim() ? 'Ward name is required' : null,
      }),
      toPayload: (v) => ({
        zone_id: Number(v.zone_id),
        ward_number: v.ward_number.trim(),
        ward_name: v.ward_name.trim(),
        ...(isEdit ? { status: v.status } : {}),
      }),
      onSubmit,
      serverErrors,
    },
  );
  return (
    <form id={formId} onSubmit={handleSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Select label="Zone" required placeholder="Select zone" value={values.zone_id} options={toOptions(lookups.zones)} fallbackLabel={initial.zone_name} onChange={(e) => setField('zone_id', e.target.value)} error={errorFor('zone_id')} />
      </div>
      <Input label="Ward number" required value={values.ward_number} onChange={(e) => setField('ward_number', e.target.value)} error={errorFor('ward_number')} />
      <Input label="Ward name" required value={values.ward_name} onChange={(e) => setField('ward_name', e.target.value)} error={errorFor('ward_name')} />
      {isEdit && <Select label="Status" value={values.status} options={STATUS_OPTIONS} onChange={(e) => setField('status', e.target.value)} />}
    </form>
  );
}

const config = {
  title: 'Wards',
  description: 'Wards within zones.',
  singular: 'Ward',
  permission: 'wards',
  labelKey: 'ward_name',
  api: wardsApi,
  lookupTypes: ['zones'],
  searchPlaceholder: 'Ward number or name',
  filters: [
    { key: 'zone_id', label: 'Zone', type: 'select', options: (l) => toOptions(l.zones) },
    { key: 'status', label: 'Status', type: 'select', options: () => STATUS_OPTIONS },
  ],
  columns: [
    { key: 'ward_number', header: 'Ward no.' },
    { key: 'ward_name', header: 'Name' },
    { key: 'zone_name', header: 'Zone' },
  ],
  Form: WardForm,
  conflictMessages: { wards_zone_id_ward_number_key: 'This ward number already exists in the selected zone' },
  conflictFallback: 'Ward cannot be saved: it conflicts with existing records (e.g. vehicles or PIDs still linked to its zone).',
};

export default function WardsPage() {
  return <MasterListPage config={config} />;
}
