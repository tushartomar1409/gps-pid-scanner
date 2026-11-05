// GPS Integration Settings (gps:read, GUIDE #9 F2). Read-only config + provider status + recent runs.
import { Fragment, useState } from 'react';
import { gpsApi } from '../../api/resources.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useToast } from '../../components/Toast.jsx';
import { Button } from '../../components/Button.jsx';
import { ErrorState } from '../../components/ErrorState.jsx';
import { Spinner } from '../../components/Spinner.jsx';
import { STATE_STYLE } from '../../components/GpsStatusBadge.jsx';
import { formatDateTime } from '../../utils/format.js';
import { parseApiError } from '../../utils/apiErrors.js';

const CONFIG_LABELS = [
  ['provider', 'Provider'], ['simulator', 'Simulator'], ['poll_enabled', 'Polling enabled'], ['poll_interval_seconds', 'Poll interval (s)'],
  ['provider_timeout_ms', 'Provider timeout (ms)'], ['provider_timezone', 'Provider timezone'], ['future_tolerance_seconds', 'Future tolerance (s)'],
  ['store_raw_payload', 'Store raw payload'], ['detection_worker_enabled', 'Detection worker enabled'], ['detection_batch_size', 'Detection batch size'],
];
const show = (v) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v ?? '—');

export function pollNowMessage(err) {
  const p = parseApiError(err);
  return p.status === 429 ? 'Poll-now is limited to once every 30 seconds. Please wait and try again.' : p.message;
}

export default function GpsIntegrationPage() {
  const { user } = useAuth();
  const toast = useToast();
  const cfg = useApiQuery(() => gpsApi.config().then((r) => r.data), 'cfg');
  const st = useApiQuery((signal) => gpsApi.providerStatus({ signal }).then((r) => r.data), 'status');
  const [polling, setPolling] = useState(false);
  const [pollError, setPollError] = useState(null);
  const [open, setOpen] = useState(null);

  const pollNow = async () => {
    setPolling(true);
    setPollError(null);
    try {
      const { data } = await gpsApi.pollNow();
      toast.success(`Poll finished: ${data?.outcome ?? 'done'} (${data?.saved ?? 0} saved)`);
      st.reload();
    } catch (err) {
      setPollError(pollNowMessage(err));
    } finally {
      setPolling(false);
    }
  };

  const s = st.data;
  const style = s ? STATE_STYLE[s.state] || STATE_STYLE.UNKNOWN : null;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">GPS Integration</h1>
        <p className="text-sm text-slate-500">Provider credentials are configured on the server and never shown here.</p>
      </div>
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Configuration">
        <h2 className="mb-2 text-sm font-semibold text-slate-800">Configuration (read-only)</h2>
        {cfg.error ? <ErrorState message={cfg.error} onRetry={cfg.reload} /> : !cfg.data ? <Spinner /> : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {CONFIG_LABELS.map(([k, label]) => (
              <div key={k} className="flex justify-between border-b border-slate-100 py-1">
                <dt className="text-slate-500">{label}</dt>
                <dd className="font-medium text-slate-800">{show(cfg.data[k])}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Provider status">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-800">Provider status</h2>
          {user?.role_key === 'SUPER_ADMIN' && <Button size="sm" variant="secondary" loading={polling} onClick={pollNow}>Poll now</Button>}
        </div>
        {pollError && <p className="mb-2 text-sm text-red-700" role="alert">{pollError}</p>}
        {st.error ? <ErrorState message={st.error} onRetry={st.reload} /> : !s ? <Spinner /> : (
          <>
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className={`h-3 w-3 rounded-full ${style.dot}`} aria-hidden="true" />
              <span className="font-semibold">{s.state}</span>
              {s.reason && <span className="text-slate-600">— {s.reason}</span>}
              <span className="text-slate-500">· last success {formatDateTime(s.last_success_at)}</span>
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>{['Started', 'Trigger', 'Outcome', 'Received', 'Saved', 'Rejected', ''].map((h) => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(s.recent_runs || []).map((r) => (
                    <Fragment key={r.id}>
                      <tr>
                        <td className="whitespace-nowrap px-3 py-1.5">{formatDateTime(r.started_at)}</td>
                        <td className="px-3 py-1.5">{r.trigger}</td>
                        <td className="px-3 py-1.5">{r.outcome}</td>
                        <td className="px-3 py-1.5 tabular-nums">{r.records_received}</td>
                        <td className="px-3 py-1.5 tabular-nums">{r.records_saved}</td>
                        <td className="px-3 py-1.5 tabular-nums">{r.records_rejected}</td>
                        <td className="px-3 py-1.5">
                          {(r.records_rejected > 0 || r.error_message) && (
                            <button type="button" className="text-xs font-medium text-emerald-700 hover:underline" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                              {open === r.id ? 'Hide' : 'Details'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {open === r.id && (
                        <tr>
                          <td colSpan={7} className="bg-slate-50 px-3 py-2 text-xs">
                            {r.error_message && <p className="text-red-700">{r.error_message}</p>}
                            {r.rejected_breakdown && (
                              <ul className="flex flex-wrap gap-3">
                                {Object.entries(r.rejected_breakdown).map(([k, v]) => <li key={k}><span className="font-mono">{k}</span>: {v}</li>)}
                              </ul>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {!s.recent_runs?.length && <tr><td colSpan={7} className="px-3 py-4 text-center text-slate-500">No poll runs yet</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
