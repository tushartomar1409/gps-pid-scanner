import { useEffect, useState } from 'react';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { ZoneWardSelects } from './ZoneWardSelects.jsx';
import { useFormState, idOrNull, str } from '../../hooks/useFormState.js';
import { toOptions } from '../../hooks/useLookups.js';
import { referenceApi } from '../../api/resources.js';

export const USER_STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'LOCKED', label: 'Locked' },
];

/** Which scope fields each role uses (mirrors backend userService rules). */
export const ROLE_SCOPE = {
  SUPER_ADMIN: [],
  DEPARTMENT_ADMIN: [],
  ZONE_ADMIN: ['zone_id'],
  WARD_SUPERVISOR: ['zone_id', 'ward_id'],
  AGENCY_USER: ['agency_id'],
};

// Mirrors be/src/services/passwordPolicy.js (the server also rejects common passwords).
export const PASSWORD_HINT = 'At least 10 characters, with a letter and a digit; not your email; not a common password.';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateUser(v, isEdit) {
  const scope = ROLE_SCOPE[v.role_key] || [];
  let password = null;
  if (!isEdit && !v.password) password = 'Password is required';
  else if (v.password) {
    const local = v.email.trim().toLowerCase().split('@')[0];
    if (v.password.length < 10) password = 'At least 10 characters';
    else if (v.password.length > 72) password = 'At most 72 characters';
    else if (!/[A-Za-z]/.test(v.password) || !/[0-9]/.test(v.password)) password = 'Must contain a letter and a digit';
    else if (v.password.toLowerCase() === v.email.trim().toLowerCase() || (local.length >= 4 && v.password.toLowerCase() === local)) password = 'Must not be your email address';
  }
  return {
    name: !v.name.trim() ? 'Name is required' : null,
    email: !v.email.trim() ? 'Email is required' : !EMAIL_RE.test(v.email.trim()) ? 'Enter a valid email' : null,
    password,
    role_key: !v.role_key ? 'Role is required' : null,
    zone_id: v.role_key === 'ZONE_ADMIN' && !v.zone_id ? 'Zone is required for Zone Admin' : null,
    ward_id: v.role_key === 'WARD_SUPERVISOR' && !v.ward_id ? 'Ward is required for Ward Supervisor' : null,
    agency_id: scope.includes('agency_id') && !v.agency_id ? 'Agency is required for Agency User' : null,
  };
}

export function UserForm({ formId, initial, isEdit, lookups, serverErrors, onSubmit }) {
  const [roles, setRoles] = useState([]);
  useEffect(() => {
    let cancelled = false;
    referenceApi
      .roles()
      .then(({ data }) => !cancelled && setRoles(data))
      .catch(() => !cancelled && setRoles([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const { values, setField, errorFor, handleSubmit } = useFormState(
    {
      name: initial.name ?? '',
      email: initial.email ?? '',
      password: '',
      role_key: initial.role_key ?? '',
      zone_id: str(initial.zone_id),
      ward_id: str(initial.ward_id),
      agency_id: str(initial.agency_id),
      status: initial.status ?? 'ACTIVE',
    },
    {
      validate: (v) => validateUser(v, isEdit),
      toPayload: (v) => {
        const scope = ROLE_SCOPE[v.role_key] || [];
        const body = {
          name: v.name.trim(),
          email: v.email.trim().toLowerCase(),
          role_key: v.role_key,
          zone_id: scope.includes('zone_id') ? idOrNull(v.zone_id) : null,
          ward_id: scope.includes('ward_id') ? idOrNull(v.ward_id) : null,
          agency_id: scope.includes('agency_id') ? idOrNull(v.agency_id) : null,
        };
        if (v.password) body.password = v.password;
        if (isEdit) body.status = v.status;
        return body;
      },
      onSubmit,
      serverErrors,
    },
  );

  const scope = ROLE_SCOPE[values.role_key] || [];
  const roleOptions = roles.map((r) => ({ value: r.role_key, label: r.role_name }));

  return (
    <form id={formId} onSubmit={handleSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
      <Input label="Full name" required value={values.name} onChange={(e) => setField('name', e.target.value)} error={errorFor('name')} />
      <Input label="Email" type="email" required autoComplete="off" value={values.email} onChange={(e) => setField('email', e.target.value)} error={errorFor('email')} />
      <Input
        label={isEdit ? 'New password' : 'Password'}
        type="password"
        required={!isEdit}
        autoComplete="new-password"
        value={values.password}
        onChange={(e) => setField('password', e.target.value)}
        error={errorFor('password')}
        hint={`${isEdit ? 'Leave blank to keep the current password. ' : ''}${PASSWORD_HINT}`}
      />
      <Select
        label="Role"
        required
        placeholder="Select role"
        value={values.role_key}
        options={roleOptions}
        fallbackLabel={initial.role_name}
        onChange={(e) => setField('role_key', e.target.value)}
        error={errorFor('role_key')}
      />

      {scope.includes('zone_id') && (
        <ZoneWardSelects
          values={values}
          setField={setField}
          errorFor={errorFor}
          lookups={lookups}
          initial={initial}
          zoneRequired
          wardRequired={scope.includes('ward_id')}
          showWard={scope.includes('ward_id')}
        />
      )}
      {scope.includes('agency_id') && (
        <Select
          label="Agency"
          required
          placeholder="Select agency"
          value={values.agency_id}
          options={toOptions(lookups.agencies)}
          fallbackLabel={initial.agency_name}
          onChange={(e) => setField('agency_id', e.target.value)}
          error={errorFor('agency_id')}
        />
      )}
      {values.role_key && scope.length === 0 && (
        <p className="self-end text-xs text-slate-500 sm:col-span-2">This role has organisation-wide access; no zone/ward/agency scope applies.</p>
      )}
      {isEdit && <Select label="Status" value={values.status} options={USER_STATUS_OPTIONS} onChange={(e) => setField('status', e.target.value)} />}
    </form>
  );
}
