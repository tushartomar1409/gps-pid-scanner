import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssignmentForm } from '../pages/assignments/AssignmentForm.jsx';
import { buildShiftIso, formatShift } from '../utils/dates.js';
import { describeError, canCancel, canResnapshot } from '../pages/assignments/AssignmentsPage.jsx';

vi.mock('../api/resources.js', () => ({ assignmentsApi: {}, referenceApi: { lookups: vi.fn() } }));

const lookups = {
  zones: [{ id: 1, name: 'NIT', code: 'NIT' }, { id: 2, name: 'BGH', code: 'BGH' }],
  wards: [{ id: 5, name: 'Ward 12', code: '12', zone_id: 1 }],
  agencies: [{ id: 3, name: 'ABC' }, { id: 4, name: 'XYZ' }],
  routes: [{ id: 10, name: 'Loop', code: 'R1', zone_id: 1, ward_id: 5 }, { id: 11, name: 'Other', code: 'R2', zone_id: 2, ward_id: 6 }],
  vehicles: [{ id: 20, name: 'HR38AB1234', code: 'Tipper', agency_id: 3 }, { id: 21, name: 'DL1C0001', code: 'Tipper', agency_id: 4 }],
};

function renderForm() {
  const onSubmit = vi.fn();
  render(
    <>
      <AssignmentForm formId="f" lookups={lookups} defaultDate="2026-11-10" onSubmit={onSubmit} />
      <button type="submit" form="f">Submit</button>
    </>,
  );
  return onSubmit;
}

describe('buildShiftIso', () => {
  it('adds an explicit +05:30 offset and rolls the end to the next day across midnight', () => {
    expect(buildShiftIso('2026-11-10', '06:00', '14:00')).toEqual({
      shift_start: '2026-11-10T06:00:00+05:30', shift_end: '2026-11-10T14:00:00+05:30', crossesMidnight: false,
    });
    expect(buildShiftIso('2026-11-30', '20:00', '04:00')).toMatchObject({
      shift_start: '2026-11-30T20:00:00+05:30', shift_end: '2026-12-01T04:00:00+05:30', crossesMidnight: true,
    });
    expect(buildShiftIso('2026-11-10', '', '')).toBeNull();
    expect(buildShiftIso('2026-11-10', '06:00', '')).toHaveProperty('error');
  });

  it('formats shift windows in IST with a +1 marker', () => {
    expect(formatShift({ operational_date: '2026-11-10', shift_start: '2026-11-10T14:30:00.000Z', shift_end: '2026-11-10T22:30:00.000Z' })).toBe('20:00–04:00 (+1)');
    expect(formatShift({ operational_date: '2026-11-10', shift_start: null })).toBe('All day');
  });
});

describe('AssignmentForm', () => {
  it('filters routes by zone and vehicles by agency, and sends +05:30 shift strings', async () => {
    const onSubmit = renderForm();
    await userEvent.selectOptions(screen.getByLabelText('Zone (filter)'), '1');
    const routeOptions = [...screen.getByLabelText(/^Route/).querySelectorAll('option')].map((o) => o.textContent);
    expect(routeOptions).toContain('R1 — Loop');
    expect(routeOptions).not.toContain('R2 — Other');
    await userEvent.selectOptions(screen.getByLabelText(/^Route/), '10');

    await userEvent.selectOptions(screen.getByLabelText('Agency (filter)'), '3');
    const vehicleOptions = [...screen.getByLabelText(/^Vehicle/).querySelectorAll('option')].map((o) => o.textContent);
    expect(vehicleOptions).toContain('HR38AB1234 (Tipper)');
    expect(vehicleOptions).not.toContain('DL1C0001 (Tipper)');
    await userEvent.selectOptions(screen.getByLabelText(/^Vehicle/), '20');

    await userEvent.type(screen.getByLabelText('Shift start (IST)'), '21:00');
    await userEvent.type(screen.getByLabelText('Shift end (IST)'), '05:00');
    expect(screen.getByText(/crosses midnight/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(onSubmit).toHaveBeenCalledWith({
      route_id: 10, vehicle_id: 20, operational_date: '2026-11-10',
      shift_start: '2026-11-10T21:00:00+05:30', shift_end: '2026-11-11T05:00:00+05:30',
    });
  });

  it('sends no shift fields for an all-day assignment and validates required fields', async () => {
    const onSubmit = renderForm();
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(screen.getByText('Route is required')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByLabelText(/^Route/), '10');
    await userEvent.selectOptions(screen.getByLabelText(/^Vehicle/), '21');
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).toHaveBeenCalledWith({ route_id: 10, vehicle_id: 21, operational_date: '2026-11-10' });
  });
});

describe('assignment page helpers', () => {
  it('turns server 409s into one readable sentence and mirrors action rules', () => {
    const err = { response: { status: 409, data: { message: 'Vehicle already has an all-day assignment (no shift window) on this date', errors: [{ field: 'shift_start', message: 'Existing all-day assignment 7 (R1); give one of them a shift window' }] } } };
    expect(describeError(err)).toBe('Vehicle already has an all-day assignment (no shift window) on this date. Existing all-day assignment 7 (R1); give one of them a shift window');
    expect(canCancel({ status: 'PLANNED' })).toBe(true);
    expect(canCancel({ status: 'COMPLETED' })).toBe(false);
    expect(canResnapshot({ status: 'ACTIVE' })).toBe(false);
  });
});
