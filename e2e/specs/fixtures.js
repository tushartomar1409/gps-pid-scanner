// Shared fixtures: every test collects CSP violations (securitypolicyviolation) and console errors and FAILS
// on any (GUIDE #11 D2.9). Helpers read Leaflet canvas markers through window.__e2eMap (VITE_E2E build only).
import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { STATE_FILE, ROOT } from '../global-setup.js';

export const state = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
export const SHOTS = path.join(ROOT, 'workflow-docs', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

// Errors that are about the environment, not the app (map tiles need internet; a socket reconnect during
// server-side polling bursts). Everything else fails the test.
const IGNORED_CONSOLE = [/tile\.openstreetmap\.org/i, /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/i];

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const consoleErrors = [];
    await page.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__csp.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample });
      });
    });
    page.on('console', (m) => {
      if (m.type() === 'error' && !IGNORED_CONSOLE.some((re) => re.test(m.text()))) consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    await use(page);
    const csp = await page.evaluate(() => window.__csp || []).catch(() => []);
    testInfo.annotations.push({ type: 'csp-violations', description: String(csp.length) });
    expect(csp, `CSP violations: ${JSON.stringify(csp)}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  },
});
export { expect };

export async function login(page, { email, password }) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
}

export async function logout(page) {
  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** CircleMarkers on the current Leaflet map: { lat, lng, x, y (page coords), fill, label }. */
export async function markers(page) {
  return page.evaluate(() => {
    const m = window.__e2eMap;
    if (!m) return [];
    const box = m.getContainer().getBoundingClientRect();
    const out = [];
    m.eachLayer((l) => {
      if (typeof l.getLatLng !== 'function' || typeof l.getRadius !== 'function') return;
      const ll = l.getLatLng();
      const p = m.latLngToContainerPoint(ll);
      const c = l.getTooltip?.()?.getContent();
      const label = typeof c === 'string' ? c : c?.textContent || ''; // react-leaflet renders JSX tooltips into an element
      out.push({ lat: ll.lat, lng: ll.lng, x: box.left + p.x, y: box.top + p.y, fill: l.options.fillColor, label });
    });
    return out;
  });
}

export const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });

/** Authenticated API call from the test runner (not the browser), for lookups the specs need. */
export async function apiAs(creds, method, p, body) {
  const { API } = await import('../global-setup.js');
  const t = (await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds) })).json()).data.token;
  const r = await fetch(`${API}/api${p}`, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return (await r.json()).data;
}
