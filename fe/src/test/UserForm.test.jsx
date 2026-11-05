import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserForm } from '../pages/masters/UserForm.jsx';
import { referenceApi } from '../api/resources.js';

vi.mock('../api/resources.js', () => ({
  referenceApi: { roles: vi.fn(), lookups: vi.fn() },
}));

const lookups = {
  zones: [{ id: 1, name: 'NIT', code: 'NIT' }, { id: 2, name: 'Ballabgarh', code: 'BGH' }],
  wards: [{ id: 10, name: 'Ward 12', code: '12', zone_id: 1 }, { id: 20, name: 'Ward 30', code: '30', zone_id: 2 }],
  agencies: [{ id: 5, name: 'ABC Agency' }],
};

async function renderForm(props = {}) {
  const onSubmit = vi.fn();
  render(
    <>
      <UserForm formId="f" initial={{}} isEdit={false} lookups={lookups} serverErrors={{}} onSubmit={onSubmit} {...props} />
      <button type="submit" form="f">Submit</button>
    </>,
  );
  await screen.findByRole('option', { name: 'Zone Admin' });
  return { onSubmit };
}

const roleSelect = () => screen.getByLabelText(/^Role/);
const field = (name) => screen.queryByLabelText(new RegExp(`^${name}`));

describe('UserForm scope fields', () => {
  beforeEach(() => {
    referenceApi.roles.mockResolvedValue({
      data: [
        { role_key: 'SUPER_ADMIN', role_name: 'Super Admin' },
        { role_key: 'DEPARTMENT_ADMIN', role_name: 'Department Admin' },
        { role_key: 'ZONE_ADMIN', role_name: 'Zone Admin' },
        { role_key: 'WARD_SUPERVISOR', role_name: 'Ward Supervisor' },
        { role_key: 'AGENCY_USER', role_name: 'Agency User' },
      ],
    });
  });

  it('shows/hides zone, ward and agency fields by role', async () => {
    await renderForm();
    expect(field('Zone')).toBeNull();
    expect(field('Ward')).toBeNull();
    expect(field('Agency')).toBeNull();

    await userEvent.selectOptions(roleSelect(), 'ZONE_ADMIN');
    expect(field('Zone')).toBeInTheDocument();
    expect(field('Ward')).toBeNull();
    expect(field('Agency')).toBeNull();

    await userEvent.selectOptions(roleSelect(), 'WARD_SUPERVISOR');
    expect(field('Zone')).toBeInTheDocument();
    expect(field('Ward')).toBeInTheDocument();
    expect(field('Agency')).toBeNull();

    await userEvent.selectOptions(roleSelect(), 'AGENCY_USER');
    expect(field('Zone')).toBeNull();
    expect(field('Ward')).toBeNull();
    expect(field('Agency')).toBeInTheDocument();

    await userEvent.selectOptions(roleSelect(), 'DEPARTMENT_ADMIN');
    expect(field('Agency')).toBeNull();
    expect(screen.getByText(/organisation-wide access/)).toBeInTheDocument();
  });

  it('limits ward options to the selected zone', async () => {
    await renderForm();
    await userEvent.selectOptions(roleSelect(), 'WARD_SUPERVISOR');
    await userEvent.selectOptions(field('Zone'), '2');
    const wardOptions = [...field('Ward').querySelectorAll('option')].map((o) => o.textContent);
    expect(wardOptions).toContain('Ward 30 (30)');
    expect(wardOptions).not.toContain('Ward 12 (12)');
  });

  it('requires password on create and the role-specific scope', async () => {
    const { onSubmit } = await renderForm();
    await userEvent.type(field('Full name'), 'Ravi');
    await userEvent.type(field('Email'), 'ravi@test.local');
    await userEvent.selectOptions(roleSelect(), 'AGENCY_USER');
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(screen.getByText('Password is required')).toBeInTheDocument();
    expect(screen.getByText('Agency is required for Agency User')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits only the scope fields relevant to the role', async () => {
    const { onSubmit } = await renderForm();
    await userEvent.type(field('Full name'), 'Ravi');
    await userEvent.type(field('Email'), 'Ravi@Test.local');
    await userEvent.type(field('Password'), 'Passw0rd!x');
    await userEvent.selectOptions(roleSelect(), 'WARD_SUPERVISOR');
    await userEvent.selectOptions(field('Zone'), '1');
    await userEvent.selectOptions(field('Ward'), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Ravi', email: 'ravi@test.local', password: 'Passw0rd!x', role_key: 'WARD_SUPERVISOR',
      zone_id: 1, ward_id: 10, agency_id: null,
    });
  });

  it('makes password optional on edit and shows server field errors', async () => {
    const { onSubmit } = await renderForm({
      isEdit: true,
      initial: { id: 7, name: 'Ravi', email: 'ravi@test.local', role_key: 'DEPARTMENT_ADMIN', status: 'ACTIVE' },
      serverErrors: { email: 'Email already used' },
    });
    expect(screen.getByText('Email already used')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.not.objectContaining({ password: expect.anything() }));
  });
});
