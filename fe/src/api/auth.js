import { api, unwrap } from './client.js';

export const authApi = {
  login: (email, password) => api.post('/auth/login', { email, password }).then(unwrap),
  profile: () => api.get('/auth/profile').then(unwrap),
  logout: () => api.post('/auth/logout').then(unwrap),
  /** Revokes every token of this user on every device (GUIDE #11 C2). */
  logoutAll: () => api.post('/auth/logout-all').then(unwrap),
};
