import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.jsx';
import RouteBuilderPage from '../pages/routes/RouteBuilderPage.jsx';
import { planAssignCall, saveRouteAndPids, toggleId, addPointsWhere, buildRoutePayload } from '../pages/routes/routeBuilderLogic.js';
import { routesApi, pidsApi, referenceApi } from '../api/resources.js';

// --- Leaflet can't render in jsdom: stub the map pieces, keep the logic.
vi.mock('../components/map/BaseMap.jsx', () => ({ BaseMap: ({ children }) => <div data-testid="map">{children}</div> }));
vi.mock('../components/map/MapHelpers.jsx', () => ({ BoxSelect: () => null, FitToPoints: () => null, MapClick: () => null }));
vi.mock('../components/map/PidPointsLayer.jsx', () => ({
  PidPointsLayer: ({ points, onPointClick }) => points.map((p) => (
    <button key={p.id} type="button" onClick={() => onPointClick?.(p)}>pin {p.pid_number}</button>
  )),
}));
vi.mock('react-leaflet', () => ({ CircleMarker: () => null, Polyline: () => null, Tooltip: () => null }));
vi.mock('../auth/usePermission.js', () => ({ usePermission: () => () => true }));
vi.mock('../api/resources.js', () => ({
  routesApi: { get: vi.fn(), pids: vi.fn(), create: vi.fn(), update: vi.fn(), assignPids: vi.fn() },
  pidsApi: { map: vi.fn() },
  referenceApi: { lookups: vi.fn() },
}));

const points = [
  { id: 11, pid_number: 'P11', latitude: 28.41, longitude: 77.31, coord_status: 'IMPORTED' },
  { id: 12, pid_number: 'P12', latitude: 28.42, longitude: 77.32, coord_status: 'IMPORTED' },
];

function renderNew() {
  return render(
    <MemoryRouter initialEntries={['/routes/new']}>
      <ToastProvider>
        <Routes><Route path="/routes/:id" element={<RouteBuilderPage />} /></Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function fillAndPick() {
  await userEvent.type(screen.getByLabelText(/^Route code/), 'r-1');
  await userEvent.type(screen.getByLabelText(/^Route name/), 'Loop');
  await userEvent.selectOptions(screen.getByLabelText(/^Ward/), '5');
  await userEvent.click(await screen.findByRole('button', { name: 'pin P12' }));
}

describe('route builder logic', () => {
  it('toggles ids and box-adds points', () => {
    expect([...toggleId(new Set([1]), 2)]).toEqual([1, 2]);
    expect([...toggleId(new Set([1, 2]), 1)]).toEqual([2]);
    expect([...addPointsWhere(new Set(), points, (lat) => lat > 28.415)]).toEqual([12]);
  });

  it('plans replace for a non-empty selection, remove when everything was deselected', () => {
    expect(planAssignCall([3, 4], [1])).toEqual({ mode: 'replace', pid_ids: [3, 4] });
    expect(planAssignCall([], [1, 2])).toEqual({ mode: 'remove', pid_ids: [1, 2] });
    expect(planAssignCall([], [])).toBeNull();
  });

  it('reports a pids-step failure with the saved route id', async () => {
    const api = { create: vi.fn().mockResolvedValue({ data: { id: 9 } }), assignPids: vi.fn().mockRejectedValue({ response: { status: 422, data: { message: 'bad ward' } } }) };
    const res = await saveRouteAndPids({ api, routeId: null, payload: {}, selectedIds: [1], savedIds: [] });
    expect(res).toMatchObject({ routeId: 9, failedStep: 'pids', error: { message: 'bad ward' } });
  });

  it('builds GeoJSON [lng, lat] geometry and start/end pairs', () => {
    const p = buildRoutePayload({ route_code: ' r1 ', route_name: 'x', ward_id: '5', zone_id: '1', agency_id: '', default_vehicle_id: '', status: 'ACTIVE' },
      { start: [28.4, 77.3], end: null, line: [[28.4, 77.3], [28.5, 77.4]], isEdit: false });
    expect(p).toMatchObject({ route_code: 'R1', ward_id: 5, zone_id: 1, agency_id: null, start_latitude: 28.4, start_longitude: 77.3, end_latitude: null });
    expect(p.route_geometry).toEqual({ type: 'LineString', coordinates: [[77.3, 28.4], [77.4, 28.5]] });
  });
});

describe('RouteBuilderPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    referenceApi.lookups.mockResolvedValue({
      data: { zones: [{ id: 1, name: 'NIT', code: 'NIT' }], wards: [{ id: 5, name: 'Ward 12', code: '12', zone_id: 1 }], agencies: [], vehicles: [] },
    });
    pidsApi.map.mockResolvedValue({ data: { points, truncated: false, count: 2 } });
    routesApi.create.mockResolvedValue({ data: { id: 42, route_code: 'R-1' } });
  });

  it('toggling a PID then saving calls assign-pids with replace and the selected ids', async () => {
    routesApi.assignPids.mockResolvedValue({ data: { added: 1, removed: 0, total: 1 } });
    renderNew();
    await fillAndPick();
    expect(screen.getByText(/Route PIDs: 1 selected/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'pin P11' }));
    await userEvent.click(screen.getByRole('button', { name: 'pin P11' })); // toggle off again
    await userEvent.click(screen.getByRole('button', { name: 'Create route' }));

    expect(routesApi.create).toHaveBeenCalledWith(expect.objectContaining({ route_code: 'R-1', route_name: 'Loop', ward_id: 5, zone_id: 1 }));
    expect(routesApi.assignPids).toHaveBeenCalledWith(42, { mode: 'replace', pid_ids: [12] });
    expect(pidsApi.map).toHaveBeenCalledWith(expect.objectContaining({ ward_id: '5', limit: 10000 }));
  });

  it('keeps the selection and offers Retry when the assign-pids call fails', async () => {
    routesApi.assignPids.mockRejectedValueOnce({ response: { status: 422, data: { message: 'Some PIDs cannot be assigned to this route' } } });
    renderNew();
    await fillAndPick();
    await userEvent.click(screen.getByRole('button', { name: 'Create route' }));

    expect(await screen.findByText(/route was saved, but its PID list was NOT saved/)).toBeInTheDocument();
    expect(screen.getByText(/Route PIDs: 1 selected/)).toBeInTheDocument();
    expect(screen.getByText('P12')).toBeInTheDocument();

    routesApi.assignPids.mockResolvedValueOnce({ data: { added: 1, removed: 0, total: 1 } });
    routesApi.update.mockResolvedValueOnce({ data: { id: 42, route_code: 'R-1' } });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(routesApi.update).toHaveBeenCalledWith(42, expect.any(Object)); // second save updates the created route
    expect(routesApi.assignPids).toHaveBeenLastCalledWith(42, { mode: 'replace', pid_ids: [12] });
    expect(routesApi.create).toHaveBeenCalledTimes(1);
  });

  it('validates required fields before calling the API', async () => {
    renderNew();
    await screen.findByLabelText(/^Ward/);
    await userEvent.click(screen.getByRole('button', { name: 'Create route' }));
    expect(screen.getByText('Route code is required')).toBeInTheDocument();
    expect(screen.getByText('Ward is required')).toBeInTheDocument();
    expect(routesApi.create).not.toHaveBeenCalled();
  });
});
