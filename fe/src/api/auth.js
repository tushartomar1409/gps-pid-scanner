import { api, unwrap } from './client.js';

export const authApi = {
  login: (email, password) => api.post('/auth/login', { email, password }).then(unwrap),
  profile: () => api.get('/auth/profile').then(unwrap),
  logout: () => api.post('/auth/logout').then(unwrap),
};
