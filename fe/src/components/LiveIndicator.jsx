import { useSocketStatus } from '../realtime/hooks.js';

export const LIVE_STYLE = {
  connected: { dot: 'bg-emerald-500', label: 'Live', title: 'Real-time updates connected' },
  reconnecting: { dot: 'bg-amber-500 animate-pulse', label: 'Reconnecting…', title: 'Real-time updates reconnecting; data will refresh when back' },
  offline: { dot: 'bg-slate-400', label: 'Offline', title: 'Real-time updates offline' },
};

export function LiveIndicator({ client }) {
  const status = useSocketStatus(client);
  const s = LIVE_STYLE[status] || LIVE_STYLE.offline;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700" title={s.title} role="status" aria-label={s.title}>
      <span className={`h-2.5 w-2.5 rounded-full ${s.dot}`} aria-hidden="true" />
      <span className="hidden sm:inline">{s.label}</span>
    </span>
  );
}
