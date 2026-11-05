import { describe, it, expect } from 'vitest';
import { safeRedirect } from '../auth/session.js';
import { parseApiError } from '../utils/apiErrors.js';

describe('safeRedirect', () => {
  it.each([
    ['/vehicles?page=2', '/vehicles?page=2'],
    ['/', '/'],
    [null, '/'],
    ['https://evil.example', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['/javascript:alert(1)', '/'],
  ])('%s -> %s', (input, expected) => expect(safeRedirect(input)).toBe(expected));
});

describe('parseApiError', () => {
  it('extracts message, field errors and constraint', () => {
    const e = parseApiError({
      response: { status: 409, data: { message: 'dup', errors: [{ field: 'vehicle_number', message: 'taken' }, { constraint: 'vehicles_vehicle_number_key' }] } },
    });
    expect(e).toEqual({ status: 409, message: 'dup', fieldErrors: { vehicle_number: 'taken' }, constraint: 'vehicles_vehicle_number_key' });
  });
  it('handles network errors and cancellations', () => {
    expect(parseApiError(new Error('x')).status).toBe(0);
    expect(parseApiError({ code: 'ERR_CANCELED' })).toEqual({ canceled: true });
  });
});
