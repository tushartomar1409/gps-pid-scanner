// Wording rule (GUIDE #8 answer 2 / #9 A5): GPS evidence is proximity, not proof of service.
// Shown on every page with coverage numbers or visit statuses. Keep in sync with the backend text.
export const GPS_DISCLAIMER = 'GPS proximity indicates that a vehicle passed near the property. It does not prove that garbage was collected.';

export const COVERAGE_LABELS = Object.freeze({
  confirmedPct: 'GPS Confirmed Coverage %',
  detectedPct: 'GPS Visit Detected %',
  remaining: 'Remaining (not GPS-confirmed)',
  remainingUndetected: 'No GPS visit detected',
  activeVehicles: 'Active (GPS on date)',
  onlineNow: 'Online now',
});
