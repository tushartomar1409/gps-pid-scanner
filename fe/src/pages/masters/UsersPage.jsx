import { MasterListPage } from './MasterListPage.jsx';
import { UserForm, USER_STATUS_OPTIONS } from './UserForm.jsx';
import { usersApi } from '../../api/resources.js';
import { formatDateTime } from '../../utils/format.js';

const ROLE_FILTER_OPTIONS = [
  { value: 'SUPER_ADMIN', label: 'Super Admin' },
  { value: 'DEPARTMENT_ADMIN', label: 'Department Admin' },
  { value: 'ZONE_ADMIN', label: 'Zone Admin' },
  { value: 'WARD_SUPERVISOR', label: 'Ward Supervisor' },
  { value: 'AGENCY_USER', label: 'Agency User' },
];

function scopeCell(r) {
  if (r.role_key === 'ZONE_ADMIN') return r.zone_name;
  if (r.role_key === 'WARD_SUPERVISOR') return [r.ward_name, r.zone_name].filter(Boolean).join(', ');
  if (r.role_key === 'AGENCY_USER') return r.agency_name;
  return 'All';
}

const config = {
  title: 'Users',
  description: 'Portal users, their roles and data scope.',
  singular: 'User',
  permission: 'users',
  labelKey: 'name',
  api: usersApi,
  lookupTypes: ['zones', 'wards', 'agencies'],
  searchPlaceholder: 'Name or email',
  filters: [
    { key: 'role_key', label: 'Role', type: 'select', options: () => ROLE_FILTER_OPTIONS },
    { key: 'status', label: 'Status', type: 'select', options: () => USER_STATUS_OPTIONS },
  ],
  columns: [
    { key: 'name', header: 'Name', render: (r) => <span className="font-medium text-slate-900">{r.name}</span> },
    { key: 'email', header: 'Email' },
    { key: 'role_name', header: 'Role' },
    { key: 'scope', header: 'Scope', render: scopeCell },
    { key: 'last_login_at', header: 'Last login', render: (r) => formatDateTime(r.last_login_at) },
  ],
  Form: UserForm,
  conflictMessages: { uq_users_email_ci: 'A user with this email already exists' },
};

export default function UsersPage() {
  return <MasterListPage config={config} />;
}
