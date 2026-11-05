// Token storage.
// NOTE: localStorage is readable by any script on the page (XSS risk). Phase 7 hardening option:
// move the JWT to an httpOnly, Secure, SameSite cookie set by the backend and drop this module.
const TOKEN_KEY = 'gpspid.token';

export function getToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable (private mode) — session lasts for this page only */
  }
}

export function clearToken() {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Only allow same-app relative paths as post-login redirect targets. Rejects absolute URLs,
 * protocol-relative "//host" and backslash tricks ("/\host") — open-redirect protection.
 */
export function safeRedirect(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return '/';
  if (path.startsWith('//') || path.includes('\\') || /^\/+[a-z][a-z0-9+.-]*:/i.test(path)) return '/';
  return path;
}
