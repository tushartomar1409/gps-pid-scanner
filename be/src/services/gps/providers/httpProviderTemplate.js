// =====================================================================================================
// TEMPLATE ONLY — NOT REGISTERED. Documentation in code form for a real REST GPS provider adapter.
// Copy to e.g. `acmeTrackProvider.js`, fill every TODO from the provider's documentation, register it
// in providers/index.js, set GPS_PROVIDER=<name>, and add sample-response unit tests for normalize().
// Do NOT guess the provider's API (flow.txt §27 rule 10): every TODO needs the real docs / samples.
// =====================================================================================================
/* eslint-disable no-unused-vars */
import { env } from '../../../config/env.js';
import { parseProviderTimestamp } from '../timestamps.js';

export function createHttpProviderTemplate({ fetchImpl = fetch } = {}) {
  // TODO: credentials from env only (never hard-coded, never sent to the frontend), e.g.
  //   GPS_PROVIDER_BASE_URL, GPS_PROVIDER_API_KEY / GPS_PROVIDER_CLIENT_ID + _CLIENT_SECRET
  const baseUrl = process.env.GPS_PROVIDER_BASE_URL; // TODO: add to env.js schema when real
  const timeoutMs = env.GPS_PROVIDER_TIMEOUT_MS;

  // ---- auth: token caching + refresh (TODO: adjust to the provider's auth scheme)
  let token = null;
  let tokenExpiresAt = 0;
  async function getToken(signal) {
    if (token && Date.now() < tokenExpiresAt - 60_000) return token; // refresh 60 s early
    // TODO: real login endpoint + body; e.g. OAuth2 client-credentials
    const res = await fetchImpl(`${baseUrl}/TODO/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ /* TODO: credentials from env */ }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
    });
    if (!res.ok) throw new Error(`GPS provider auth failed: HTTP ${res.status}`);
    const body = await res.json();
    token = body.TODO_access_token;
    tokenExpiresAt = Date.now() + (body.TODO_expires_in ?? 3600) * 1000;
    return token;
  }

  async function call(path, { signal, query } = {}) {
    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${await getToken(signal)}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
    });
    if (res.status === 401) { token = null; throw new Error('GPS provider rejected token (401)'); }
    if (res.status === 429) throw new Error('GPS provider rate limit hit (429)'); // poller backs off
    if (!res.ok) throw new Error(`GPS provider HTTP ${res.status}`);
    return res.json();
  }

  return {
    name: 'TODO_provider_name',

    // TODO: bulk "latest location of all devices" endpoint (+ pagination if any)
    async fetchLatest({ deviceIds, signal } = {}) {
      const body = await call('/TODO/devices/latest', { signal });
      return body.TODO_items ?? [];
    },

    // TODO: history endpoint; respect the provider's max time range per request
    async fetchHistory({ deviceId, from, to, signal } = {}) {
      const body = await call(`/TODO/devices/${encodeURIComponent(deviceId)}/history`, {
        signal, query: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      });
      return body.TODO_points ?? [];
    },

    // TODO: map the provider's field names / units. Keep it pure; validation happens later.
    normalize(raw) {
      const ts = parseProviderTimestamp(raw.TODO_timestamp, env.GPS_PROVIDER_TIMEZONE); // epoch/ISO/naive
      if (ts.error) return { error: ts.error };
      return {
        ok: {
          device_id: String(raw.TODO_device_id),       // IMEI? provider vehicle id? (ask the client)
          vehicle_number: raw.TODO_registration ?? undefined,
          latitude: Number(raw.TODO_lat),
          longitude: Number(raw.TODO_lng),
          speed: raw.TODO_speed == null ? null : Number(raw.TODO_speed), // TODO: convert knots/m-s to km/h
          ignition: raw.TODO_ignition == null ? null : Boolean(raw.TODO_ignition),
          heading: raw.TODO_heading == null ? null : Number(raw.TODO_heading),
          gps_accuracy: raw.TODO_hdop == null ? null : Number(raw.TODO_hdop),
          recorded_at: ts.ok,                           // MUST be device fix time, not server receive time
          provider_status: raw.TODO_status ?? null,
          raw,
        },
      };
    },
  };
}
