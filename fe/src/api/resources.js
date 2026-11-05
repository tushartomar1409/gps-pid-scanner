// Per-module REST clients matching the backend routers.
import { api, unwrap } from './client.js';

/** Drops empty query values so URLs stay clean (?status= is not sent). */
export function cleanParams(params = {}) {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

export function createResourceApi(path) {
  return {
    list: (params, { signal } = {}) => api.get(path, { params: cleanParams(params), signal }).then(unwrap),
    get: (id) => api.get(`${path}/${id}`).then(unwrap),
    create: (body) => api.post(path, body).then(unwrap),
    update: (id, body) => api.put(`${path}/${id}`, body).then(unwrap),
    deactivate: (id) => api.patch(`${path}/${id}/deactivate`).then(unwrap),
  };
}

export const zonesApi = createResourceApi('/zones');
export const wardsApi = createResourceApi('/wards');
export const agenciesApi = createResourceApi('/agencies');
export const vehiclesApi = createResourceApi('/vehicles');
export const usersApi = createResourceApi('/users');

export const pidsApi = {
  ...createResourceApi('/pids'),
  map: (params, { signal } = {}) => api.get('/pids/map', { params: cleanParams(params), signal }).then(unwrap),
  updateCoordinates: (id, body) => api.patch(`/pids/${id}/coordinates`, body).then(unwrap),
  /** mode: validate|commit. report:'csv' returns a Blob. onProgress(0..1) for the upload. */
  importFile: (file, { mode, on_existing, report } = {}, onProgress) => {
    const form = new FormData();
    form.append('file', file);
    return api
      .post('/pids/import', form, {
        params: cleanParams({ mode, on_existing, report }),
        responseType: report === 'csv' ? 'blob' : 'json',
        timeout: 180_000,
        onUploadProgress: onProgress ? (e) => e.total && onProgress(e.loaded / e.total) : undefined,
      })
      .then((res) => (report === 'csv' ? res.data : unwrap(res)));
  },
  template: (format) => api.get('/pids/import-template', { params: { format }, responseType: 'blob' }).then((r) => r.data),
};

export const routesApi = {
  ...createResourceApi('/routes'),
  pids: (id, params) => api.get(`/routes/${id}/pids`, { params: cleanParams(params) }).then(unwrap),
  assignPids: (id, body) => api.post(`/routes/${id}/assign-pids`, body).then(unwrap),
};

export const assignmentsApi = {
  list: (params, { signal } = {}) => api.get('/route-assignments', { params: cleanParams(params), signal }).then(unwrap),
  get: (id, params) => api.get(`/route-assignments/${id}`, { params: cleanParams(params) }).then(unwrap),
  create: (body) => api.post('/route-assignments', body).then(unwrap),
  bulk: (body) => api.post('/route-assignments/bulk', body, { timeout: 180_000 }).then(unwrap),
  cancel: (id) => api.patch(`/route-assignments/${id}/cancel`).then(unwrap),
  resnapshot: (id) => api.post(`/route-assignments/${id}/resnapshot`).then(unwrap),
  mapPids: (id, { signal } = {}) => api.get(`/route-assignments/${id}/map-pids`, { signal, timeout: 60_000 }).then(unwrap),
  comparison: (id, { signal } = {}) => api.get(`/route-assignments/${id}/comparison`, { signal, timeout: 60_000 }).then(unwrap),
};

export const settingsApi = {
  public: () => api.get('/settings/public').then(unwrap),
  /** SUPER_ADMIN: every setting with editable/default/schema */
  all: () => api.get('/settings').then(unwrap),
  update: (key, value) => api.put(`/settings/${encodeURIComponent(key)}`, { value }).then(unwrap),
};

export const gpsApi = {
  providerStatus: ({ signal } = {}) => api.get('/gps/provider-status', { signal }).then(unwrap),
  config: () => api.get('/gps/config').then(unwrap),
  pollNow: () => api.post('/gps/poll-now', null, { timeout: 120_000 }).then(unwrap),
  liveVehicles: (params, { signal } = {}) => api.get('/gps/live-vehicles', { params: cleanParams(params), signal }).then(unwrap),
  liveVehicle: (id, { signal } = {}) => api.get(`/gps/live-vehicles/${id}`, { signal }).then(unwrap),
  history: (params, { signal } = {}) => api.get('/gps/vehicle-history', { params: cleanParams(params), signal, timeout: 60_000 }).then(unwrap),
};

export const dashboardApi = {
  summary: (params, { signal } = {}) => api.get('/dashboard/summary', { params: cleanParams(params), signal }).then(unwrap),
  /** group: zone-coverage | ward-coverage | agency-performance | vehicle-performance */
  grouped: (group, params, { signal } = {}) => api.get(`/dashboard/${group}`, { params: cleanParams(params), signal }).then(unwrap),
  dailyTrend: (params, { signal } = {}) => api.get('/dashboard/daily-trend', { params: cleanParams(params), signal }).then(unwrap),
  hourly: (params, { signal } = {}) => api.get('/dashboard/hourly-activity', { params: cleanParams(params), signal }).then(unwrap),
};

export const visitsApi = {
  events: (params, { signal } = {}) => api.get('/pid-visits', { params: cleanParams(params), signal }).then(unwrap),
};

export const detectionApi = {
  /** body: { route_assignment_id } | { operational_date, zone_id? } */
  reprocess: (body) => api.post('/detection/reprocess', body, { timeout: 180_000 }).then(unwrap),
};

export const activityLogsApi = {
  list: (params, { signal } = {}) => api.get('/activity-logs', { params: cleanParams(params), signal }).then(unwrap),
};

export const referenceApi = {
  roles: () => api.get('/roles').then(unwrap),
  lookups: (types) => api.get('/lookups', { params: { types: types.join(',') } }).then(unwrap),
};
