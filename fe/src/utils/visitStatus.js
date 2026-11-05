// ONE status/colour map for the whole app (flow.txt §11, GUIDE #9 A4): map markers, badges, charts, legends.
// Colours are from the Okabe–Ito colour-blind-safe palette. Colour is never the only signal: every
// status also has a text label and a symbol, and map markers differ in outline/fill style.

export const VISIT_STATUS = Object.freeze({
  GPS_VISIT_CONFIRMED: {
    label: 'GPS Visit Confirmed', short: 'Confirmed', symbol: '✓', color: '#009E73',
    marker: { fillOpacity: 0.95, weight: 1, stroke: '#ffffff' },
  },
  GPS_VISIT_CANDIDATE: {
    label: 'GPS Visit Candidate', short: 'Candidate', symbol: '◐', color: '#E6B800',
    marker: { fillOpacity: 0.9, weight: 2, stroke: '#7a5c00' },
  },
  NOT_VISITED: {
    label: 'Not Visited', short: 'Not visited', symbol: '✕', color: '#D55E00',
    marker: { fillOpacity: 0.35, weight: 2.5, stroke: '#D55E00' }, // hollow-looking ring
  },
  GPS_DATA_UNAVAILABLE: {
    label: 'GPS Data Unavailable', short: 'No GPS data', symbol: '?', color: '#8C8C8C',
    marker: { fillOpacity: 0.6, weight: 1.5, stroke: '#4d4d4d', dashArray: '2 2' },
  },
});

export const VISIT_STATUS_ORDER = ['GPS_VISIT_CONFIRMED', 'GPS_VISIT_CANDIDATE', 'NOT_VISITED', 'GPS_DATA_UNAVAILABLE'];

/** Non-PID map layers (flow §11). */
export const MAP_LAYER_COLORS = Object.freeze({
  currentVehicle: { label: 'Current vehicle location', color: '#0072B2' },
  actualTrail: { label: 'Actual GPS trail', color: '#E69F00' },
  assignedRoute: { label: 'Assigned route', color: '#7B3294' },
  offRoute: { label: 'Off-route segment (dashed)', color: '#CC0000' },
});

/** Vehicle connection status (live map). */
export const CONNECTION_STATUS = Object.freeze({
  ONLINE: { label: 'Online', color: '#009E73', fill: '#009E73', fillOpacity: 0.95, stroke: '#ffffff', weight: 1.5 },
  OFFLINE: { label: 'Offline', color: '#9b6b6b', fill: '#9b6b6b', fillOpacity: 0.9, stroke: '#ffffff', weight: 1.5 },
  NO_DATA: { label: 'No data', color: '#8C8C8C', fill: '#ffffff', fillOpacity: 0.2, stroke: '#8C8C8C', weight: 2 },
  INACTIVE: { label: 'Inactive', color: '#111111', fill: '#ffffff', fillOpacity: 0.6, stroke: '#111111', weight: 2 },
});

export const visitStatusMeta = (s) => VISIT_STATUS[s] || VISIT_STATUS.GPS_DATA_UNAVAILABLE;

/** Legend items covering every flow §11 colour. */
export function coverageLegendItems() {
  return [
    ...VISIT_STATUS_ORDER.map((k) => ({ key: k, color: VISIT_STATUS[k].color, label: VISIT_STATUS[k].label, symbol: VISIT_STATUS[k].symbol })),
    ...Object.entries(MAP_LAYER_COLORS).map(([k, v]) => ({ key: k, color: v.color, label: v.label, line: k !== 'currentVehicle', dashed: k === 'offRoute' })),
  ];
}

/** Evidence types from the backend (pid_visit_events.evidence_status). */
export const EVIDENCE_LABELS = Object.freeze({
  PROXIMITY_POINT: (e) => `GPS point within ${fmtM(e?.distance_meters)}`,
  TRACK_SEGMENT: () => 'Track passed nearby (between two GPS points)',
  CONSECUTIVE_CONFIRMED: () => 'Confirmed by consecutive GPS points',
  REJECTED_SPEED: () => 'Rejected: speed',
  REJECTED_STALE: () => 'Rejected: stale',
});

function fmtM(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n * 10) / 10} m` : 'radius';
}

export function evidenceLabel(e) {
  const f = EVIDENCE_LABELS[e?.evidence_status];
  return f ? f(e) : e?.evidence_status || 'Unknown evidence';
}

export const isRejectedEvidence = (s) => s === 'REJECTED_SPEED' || s === 'REJECTED_STALE';
