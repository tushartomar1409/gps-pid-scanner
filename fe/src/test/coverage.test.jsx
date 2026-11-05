// GUIDE #9 G3: coverage map — toggles (pure), recolour on pid:status, evidence labels, legend.
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  DEFAULT_TOGGLES, appendToTrail, applyPidStatusChanges, countsFromPayload, geometryToLatLngs, pidVisible, segmentLatLngs, toggle, visiblePids,
} from '../pages/coverage/coverageLogic.js';
import { CoverageLegend } from '../pages/coverage/CoveragePanels.jsx';
import { EVIDENCE_LABELS, MAP_LAYER_COLORS, VISIT_STATUS, coverageLegendItems, evidenceLabel } from '../utils/visitStatus.js';
import { GPS_DISCLAIMER } from '../utils/disclaimer.js';

const P = (id, s, lat = 28.4) => ({ pid_id: id, pid_number: `P${id}`, latitude: lat, longitude: 77.3, visit_status: s });
const PIDS = [P(1, 'GPS_VISIT_CONFIRMED'), P(2, 'GPS_VISIT_CANDIDATE'), P(3, 'NOT_VISITED'), P(4, 'GPS_DATA_UNAVAILABLE', null)];

describe('layer toggles', () => {
  it('all PIDs on shows every drawable PID (no-coordinate PIDs are never drawn)', () => {
    expect(visiblePids(PIDS, DEFAULT_TOGGLES).map((p) => p.pid_id)).toEqual([1, 2, 3]);
  });

  it('visited = confirmed + candidate; unvisited = not visited + unavailable', () => {
    const visitedOnly = toggle(DEFAULT_TOGGLES, 'unvisited');
    expect(visitedOnly).toMatchObject({ allPids: false, visited: true, unvisited: false });
    expect(visiblePids(PIDS, visitedOnly).map((p) => p.pid_id)).toEqual([1, 2]);
    const unvisitedOnly = toggle(DEFAULT_TOGGLES, 'visited');
    expect(PIDS.filter((p) => pidVisible(p, unvisitedOnly)).map((p) => p.pid_id)).toEqual([3, 4]);
    const none = toggle(visitedOnly, 'visited');
    expect(visiblePids(PIDS, none)).toEqual([]);
  });

  it('turning visited+unvisited back on (or All PIDs on) means all; route toggles are independent', () => {
    const t = toggle(toggle(toggle(DEFAULT_TOGGLES, 'visited'), 'unvisited'), 'visited');
    expect(t).toMatchObject({ allPids: false, visited: true, unvisited: false });
    expect(toggle(t, 'unvisited').allPids).toBe(true);
    expect(toggle(toggle(DEFAULT_TOGGLES, 'visited'), 'allPids')).toMatchObject({ allPids: true, visited: true, unvisited: true });
    expect(toggle(DEFAULT_TOGGLES, 'assignedRoute')).toMatchObject({ assignedRoute: false, actualRoute: true, allPids: true });
  });
});

describe('live updates', () => {
  it('pid:status recolours only this assignment’s PIDs, in place; unchanged payload keeps the same array', () => {
    const changes = [
      { route_assignment_id: 7, pid_id: 3, old_status: 'NOT_VISITED', new_status: 'GPS_VISIT_CANDIDATE' },
      { route_assignment_id: 8, pid_id: 1, old_status: 'GPS_VISIT_CONFIRMED', new_status: 'NOT_VISITED' },
    ];
    const out = applyPidStatusChanges(PIDS, changes, 7);
    expect(out.find((p) => p.pid_id === 3).visit_status).toBe('GPS_VISIT_CANDIDATE');
    expect(out.find((p) => p.pid_id === 1).visit_status).toBe('GPS_VISIT_CONFIRMED');
    expect(out[0]).toBe(PIDS[0]); // untouched objects reused
    expect(applyPidStatusChanges(PIDS, changes.slice(1), 7)).toBe(PIDS);
  });

  it('counts come from the server payload (no client recompute of the official figures)', () => {
    const p = { assignments: [{ route_assignment_id: 7, vehicle_id: 2, assigned: 8, confirmed: 2, candidate: 3, unavailable: 1 }] };
    expect(countsFromPayload(p, 7)).toEqual({ assigned: 8, confirmed: 2, candidate: 3, remaining: 6, confirmed_pct: 25, detected_pct: 62.5 });
    expect(countsFromPayload(p, 9)).toBeNull();
  });

  it('vehicle:locations appends newer points of this vehicle to the trail only', () => {
    const trail = [{ latitude: 1, longitude: 1, recorded_at: '2031-01-01T00:00:00Z' }];
    const out = appendToTrail(trail, [
      { vehicle_id: 5, lat: 2, lng: 2, recorded_at: '2031-01-01T00:00:30Z' },
      { vehicle_id: 6, lat: 9, lng: 9, recorded_at: '2031-01-01T00:00:30Z' },
      { vehicle_id: 5, lat: 0, lng: 0, recorded_at: '2030-12-31T23:59:00Z' },
    ], 5);
    expect(out.map((p) => p.latitude)).toEqual([1, 2]);
    expect(appendToTrail(trail, [], 5)).toBe(trail);
  });

  it('geometry and off-route segment helpers', () => {
    expect(geometryToLatLngs({ type: 'LineString', coordinates: [[77.3, 28.4], [77.31, 28.41]] })).toEqual([[[28.4, 77.3], [28.41, 77.31]]]);
    expect(geometryToLatLngs(null)).toEqual([]);
    const track = [0, 1, 2, 3].map((i) => ({ latitude: i, longitude: i, recorded_at: `2031-01-01T00:0${i}:00Z` }));
    expect(segmentLatLngs(track, { from: '2031-01-01T00:01:00Z', to: '2031-01-01T00:02:00Z' })).toEqual([[1, 1], [2, 2]]);
  });
});

describe('labels and legend', () => {
  it('evidence label for every evidence type', () => {
    expect(Object.keys(EVIDENCE_LABELS).sort()).toEqual(['CONSECUTIVE_CONFIRMED', 'PROXIMITY_POINT', 'REJECTED_SPEED', 'REJECTED_STALE', 'TRACK_SEGMENT']);
    expect(evidenceLabel({ evidence_status: 'PROXIMITY_POINT', distance_meters: 12.34 })).toBe('GPS point within 12.3 m');
    expect(evidenceLabel({ evidence_status: 'TRACK_SEGMENT', distance_meters: 8 })).toBe('Track passed nearby (between two GPS points)');
    expect(evidenceLabel({ evidence_status: 'REJECTED_SPEED' })).toBe('Rejected: speed');
    expect(evidenceLabel({ evidence_status: 'REJECTED_STALE' })).toBe('Rejected: stale');
    expect(evidenceLabel({ evidence_status: 'CONSECUTIVE_CONFIRMED' })).toMatch(/consecutive/i);
    expect(evidenceLabel({ evidence_status: 'SOMETHING_NEW' })).toBe('SOMETHING_NEW');
  });

  it('legend contains every flow §11 colour (with a text label) plus the disclaimer', () => {
    render(<CoverageLegend />);
    const legend = screen.getByLabelText('Coverage legend');
    for (const s of Object.values(VISIT_STATUS)) expect(within(legend).getByText(s.label)).toBeInTheDocument();
    for (const l of Object.values(MAP_LAYER_COLORS)) expect(within(legend).getByText(l.label)).toBeInTheDocument();
    expect(within(legend).getByText(GPS_DISCLAIMER)).toBeInTheDocument();
    const colors = coverageLegendItems().map((i) => i.color.toLowerCase());
    expect(new Set(colors).size).toBe(colors.length); // every layer distinguishable
  });
});
