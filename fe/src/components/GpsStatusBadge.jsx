// Header badge: GPS provider health from GET /api/gps/provider-status, refreshed every 60 s.
import { useEffect, useState } from 'react';
import { gpsApi } from '../api/resources.js';
import { formatDateTime } from '../utils/format.js';

export const STATE_STYLE = {
  UP: { dot: 'bg-emerald-500', label: 'GPS up' },
  DEGRADED: { dot: 'bg-amber-500', label: 'GPS degraded' },
  DOWN: { dot: 'bg-red-600', label: 'GPS down' },
  UNKNOWN: { dot: 'bg-slate-400', label: 'GPS status unknown' },
};
const NEVER_POLLED = { dot: 'bg-slate-400', label: 'GPS not polled yet' };

export function GpsStatusBadge({ intervalMs = 60_000 }) {
  const [status, setStatus] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let controller = null;
    const load = () => {
      controller?.abort();
      controller = new AbortController();
      gpsApi
        .providerStatus({ signal: controller.signal })
        .then(({ data }) => { setStatus(data); setFailed(false); })
        .catch((err) => { if (err?.code !== 'ERR_CANCELED' && err?.name !== 'CanceledError') setFailed(true); });
    };
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      clearInterval(t);
      controller?.abort();
    };
  }, [intervalMs]);

  const state = failed || !status ? 'UNKNOWN' : status.state;
  // Server UNKNOWN = never polled (grey, not an outage); a failed status call is also grey but worded differently.
  const s = !failed && status?.state === 'UNKNOWN' ? NEVER_POLLED : STATE_STYLE[state] || STATE_STYLE.UNKNOWN;
  const tooltip = failed
    ? 'Could not load GPS provider status'
    : status
      ? `${s.label} (${status.provider})${status.reason ? ` — ${status.reason}` : ''}. Last success: ${status.last_success_at ? formatDateTime(status.last_success_at) : 'never'}`
      : 'Loading GPS status…';

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700" title={tooltip} role="status" aria-label={tooltip}>
      <span className={`h-2.5 w-2.5 rounded-full ${s.dot}`} aria-hidden="true" />
      <span className="hidden sm:inline">{s.label}</span>
    </span>
  );
}
