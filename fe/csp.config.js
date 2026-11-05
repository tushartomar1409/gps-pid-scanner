// Content-Security-Policy for the SPA (GUIDE #11 C3). ONE definition, used by:
//   - `vite preview` when CSP=1 (the e2e run checks for violations under it)
//   - the nginx config in workflow-docs/security-review.md (generate it with `node csp.config.js`)
// No 'unsafe-inline' / 'unsafe-eval' for scripts. Styles: React/Leaflet/Recharts set styles through the
// CSSOM (element.style), which CSP does not restrict, so style-src 'self' is enough (verified by e2e).

/** Origin(s) allowed for map tiles, from VITE_MAP_TILE_URL (handles the {s} subdomain placeholder). */
export function tileSources(tileUrl = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png') {
  const u = new URL(tileUrl.replace(/\{s\}/g, 'a').replace(/\{[a-z]+\}/gi, '0'));
  return tileUrl.includes('{s}') ? [`${u.protocol}//*.${u.host.split('.').slice(1).join('.')}`] : [u.origin];
}

export function buildCsp({ tileUrl, apiOrigin } = {}) {
  const connect = ["'self'", ...(apiOrigin ? [apiOrigin, apiOrigin.replace(/^http/, 'ws')] : [])];
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'blob:', ...tileSources(tileUrl)],
    'font-src': ["'self'", 'data:'],
    'connect-src': connect, // 'self' covers same-origin ws:/wss: (CSP Level 3) for Socket.IO behind nginx
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'worker-src': ["'self'", 'blob:'],
  };
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

// `node csp.config.js` prints the nginx lines for the configured tile server.
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('csp.config.js')) {
  const csp = buildCsp({ tileUrl: process.env.VITE_MAP_TILE_URL });
  console.log(`add_header Content-Security-Policy "${csp}" always;`);
}
