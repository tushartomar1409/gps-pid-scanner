// Per-module REST clients matching the backend CRUD router.
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

export const referenceApi = {
  roles: () => api.get('/roles').then(unwrap),
  lookups: (types) => api.get('/lookups', { params: { types: types.join(',') } }).then(unwrap),
};
