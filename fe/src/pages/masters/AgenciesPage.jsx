import { MasterListPage, STATUS_OPTIONS } from './MasterListPage.jsx';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { useFormState, textOrNull } from '../../hooks/useFormState.js';
import { agenciesApi } from '../../api/resources.js';

const MOBILE_RE = /^[0-9+\- ]{7,15}$/;

function AgencyForm({ formId, initial, isEdit, serverErrors, onSubmit }) {
  const { values, setField, errorFor, handleSubmit } = useFormState(
    {
      agency_name: initial.agency_name ?? '',
      contact_person: initial.contact_person ?? '',
      mobile: initial.mobile ?? '',
      address: initial.address ?? '',
      status: initial.status ?? 'ACTIVE',
    },
    {
      validate: (v) => ({
        agency_name: !v.agency_name.trim() ? 'Agency name is required' : null,
        mobile: v.mobile.trim() && !MOBILE_RE.test(v.mobile.trim()) ? '7–15 digits; may include +, - and spaces' : null,
      }),
      toPayload: (v) => ({
        agency_name: v.agency_name.trim(),
        contact_person: textOrNull(v.contact_person),
        mobile: textOrNull(v.mobile),
        address: textOrNull(v.address),
        ...(isEdit ? { status: v.status } : {}),
      }),
      onSubmit,
      serverErrors,
    },
  );
  return (
    <form id={formId} onSubmit={handleSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Input label="Agency name" required value={values.agency_name} onChange={(e) => setField('agency_name', e.target.value)} error={errorFor('agency_name')} />
      </div>
      <Input label="Contact person" value={values.contact_person} onChange={(e) => setField('contact_person', e.target.value)} error={errorFor('contact_person')} />
      <Input label="Mobile" inputMode="tel" value={values.mobile} onChange={(e) => setField('mobile', e.target.value)} error={errorFor('mobile')} />
      <div className="sm:col-span-2">
        <Input label="Address" value={values.address} onChange={(e) => setField('address', e.target.value)} error={errorFor('address')} />
      </div>
      {isEdit && <Select label="Status" value={values.status} options={STATUS_OPTIONS} onChange={(e) => setField('status', e.target.value)} />}
    </form>
  );
}

const config = {
  title: 'Agencies',
  description: 'Collection agencies operating vehicles.',
  singular: 'Agency',
  permission: 'agencies',
  labelKey: 'agency_name',
  api: agenciesApi,
  searchPlaceholder: 'Name, contact or mobile',
  filters: [{ key: 'status', label: 'Status', type: 'select', options: () => STATUS_OPTIONS }],
  columns: [
    { key: 'agency_name', header: 'Agency' },
    { key: 'contact_person', header: 'Contact' },
    { key: 'mobile', header: 'Mobile' },
    { key: 'vehicle_count', header: 'Vehicles' },
  ],
  Form: AgencyForm,
  conflictMessages: { agencies_agency_name_key: 'An agency with this name already exists' },
};

export default function AgenciesPage() {
  return <MasterListPage config={config} />;
}
