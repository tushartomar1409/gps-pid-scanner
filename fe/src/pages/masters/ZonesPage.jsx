import { MasterListPage, STATUS_OPTIONS } from './MasterListPage.jsx';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { useFormState } from '../../hooks/useFormState.js';
import { zonesApi } from '../../api/resources.js';

const CODE_RE = /^[A-Za-z0-9_-]{1,20}$/;

export function validateZone(v) {
  return {
    zone_code: !v.zone_code.trim() ? 'Zone code is required' : !CODE_RE.test(v.zone_code.trim()) ? 'Up to 20 letters, digits, _ or -' : null,
    zone_name: !v.zone_name.trim() ? 'Zone name is required' : v.zone_name.trim().length > 100 ? 'Max 100 characters' : null,
  };
}

function ZoneForm({ formId, initial, isEdit, serverErrors, onSubmit }) {
  const { values, setField, errorFor, handleSubmit } = useFormState(
    { zone_code: initial.zone_code ?? '', zone_name: initial.zone_name ?? '', status: initial.status ?? 'ACTIVE' },
    {
      validate: validateZone,
      toPayload: (v) => ({ zone_code: v.zone_code.trim(), zone_name: v.zone_name.trim(), ...(isEdit ? { status: v.status } : {}) }),
      onSubmit,
      serverErrors,
    },
  );
  return (
    <form id={formId} onSubmit={handleSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
      <Input label="Zone code" required value={values.zone_code} onChange={(e) => setField('zone_code', e.target.value)} error={errorFor('zone_code')} hint="Stored in upper case, e.g. NIT" />
      <Input label="Zone name" required value={values.zone_name} onChange={(e) => setField('zone_name', e.target.value)} error={errorFor('zone_name')} />
      {isEdit && <Select label="Status" value={values.status} options={STATUS_OPTIONS} onChange={(e) => setField('status', e.target.value)} />}
    </form>
  );
}

const config = {
  title: 'Zones',
  description: 'Administrative zones. Each ward belongs to one zone.',
  singular: 'Zone',
  permission: 'zones',
  labelKey: 'zone_name',
  api: zonesApi,
  searchPlaceholder: 'Code or name',
  filters: [{ key: 'status', label: 'Status', type: 'select', options: () => STATUS_OPTIONS }],
  columns: [
    { key: 'zone_code', header: 'Code', render: (r) => <span className="font-mono text-xs">{r.zone_code}</span> },
    { key: 'zone_name', header: 'Name' },
    { key: 'ward_count', header: 'Wards' },
  ],
  Form: ZoneForm,
  conflictMessages: { zones_zone_code_key: 'Zone code already exists' },
};

export default function ZonesPage() {
  return <MasterListPage config={config} />;
}
