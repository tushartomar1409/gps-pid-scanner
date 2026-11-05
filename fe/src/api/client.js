// Single axios instance for the backend. Adds the Bearer token; on 401 (outside the login call)
// clears the session and notifies the registered handler (AuthContext -> /login?expired=1).
import axios from 'axios';
import { getToken, clearToken } from '../auth/session.js';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 20_000,
});

let unauthorizedHandler = null;
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;
    const isLogin = error?.config?.url?.includes('/auth/login');
    if (status === 401 && !isLogin && getToken()) {
      clearToken();
      unauthorizedHandler?.();
    }
    return Promise.reject(error);
  },
);

/** Unwraps the standard envelope: returns { data, pagination, message }. */
export const unwrap = (res) => ({ data: res.data.data, pagination: res.data.pagination, message: res.data.message });
