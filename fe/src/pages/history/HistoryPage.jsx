// Historical GPS tracking + playback (GUIDE #9 E, flow §14.6).
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { CircleMarker, Polyline, Tooltip } from 'react-leaflet';
import { assignmentsApi, gpsApi } from '../../api/resources.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { usePermission } from '../../auth/usePermission.js';
import { usePermittedLookups, useUrlFilters } from '../../components/MonitoringFilters.jsx';
import { BaseMap } from '../../components/map/BaseMap.jsx';
import { FitToPoints } from '../../components/map/MapHelpers.jsx';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { Button } from '../../components/Button.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { ErrorState } from '../../components/ErrorState.jsx';
import { Spinner } from '../../components/Spinner.jsx';
import { Disclaimer } from '../../components/Disclaimer.jsx';
import { MAP_LAYER_COLORS } from '../../utils/visitStatus.js';
import { todayIST } from '../../utils/dates.js';
import { formatDateTime } from '../../utils/format.js';
import { PidStatusLayer } from '../coverage/CoverageLayers.jsx';
import { SPEEDS, historyWindow, initialPlayback, playbackReducer, positionAt, timeline } from './playback.js';

const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** PIDs of the vehicle's assignments on that date (final statuses), for the overlay. */
function useDayPids(vehicleId, date, enabled) {
  return useApiQuery(async (signal) => {
    const { data } = await assignmentsApi.list({ operational_date: date, vehicle_id: vehicleId, limit: 20 }, { signal });
    const lists = await Promise.all(data.filter((a) => a.status !== 'CANCELLED').map((a) => assignmentsApi.mapPids(a.id, { signal }).then((r) => r.data.pids)));
    return lists.flat();
  }, `${vehicleId}|${date}`, { enabled });
}

export default function HistoryPage() {
  const can = usePermission();
  const lookups = usePermittedLookups(['vehicles']);
  const [f, setF] = useUrlFilters(['vehicle_id', 'date', 'start', 'end'], { date: todayIST(), start: '00:00', end: '23:59' });
  const [submitted, setSubmitted] = useState(() => (f.vehicle_id ? { ...f } : null));
  const [showPids, setShowPids] = useState(false);
  const win = historyWindow(f.date, f.start || '00:00', f.end || '23:59');

  const key = submitted ? JSON.stringify(submitted) : null;
  const q = useApiQuery(
    (signal) => {
      const w = historyWindow(submitted.date, submitted.start || '00:00', submitted.end || '23:59');
      return gpsApi.history({ vehicle_id: submitted.vehicle_id, from: w.from, to: w.to, max_points: 5000 }, { signal }).then((r) => r.data);
    },
    key, { enabled: Boolean(submitted && !historyWindow(submitted.date, submitted.start, submitted.end).error) },
  );
  const points = useMemo(() => q.data?.points || [], [q.data]);
  const tl = useMemo(() => timeline(points), [points]);
  const [pb, dispatch] = useReducer((s, a) => playbackReducer(s, a, tl.duration), initialPlayback);
  const dayPids = useDayPids(submitted?.vehicle_id, submitted?.date, Boolean(submitted && showPids && can('assignments:read')));

  useEffect(() => dispatch({ type: 'reset' }), [q.data]);

  // Animation loop: wall-clock delta × speed (real time order, not one step per point).
  const last = useRef(null);
  useEffect(() => {
    if (!pb.playing) {
      last.current = null;
      return undefined;
    }
    let raf;
    const step = (t) => {
      if (last.current !== null) dispatch({ type: 'tick', dtMs: t - last.current });
      last.current = t;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [pb.playing]);

  const pos = positionAt(points, tl, pb.playheadMs);
  const line = useMemo(() => points.map((p) => [p.latitude, p.longitude]), [points]);

  const onSubmit = (e) => {
    e.preventDefault();
    if (!f.vehicle_id || win.error) return;
    setSubmitted({ ...f });
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">GPS History</h1>
        <p className="text-sm text-slate-500">Replay a vehicle&apos;s GPS track (IST, max 24 h)</p>
      </div>
      <form onSubmit={onSubmit} className="grid grid-cols-2 items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:grid-cols-5" aria-label="History query">
        <Select label="Vehicle" required placeholder="Select vehicle" value={f.vehicle_id}
          options={(lookups.vehicles || []).map((v) => ({ value: String(v.id), label: v.name }))} onChange={(e) => setF({ vehicle_id: e.target.value })} />
        <Input label="Date" type="date" value={f.date} max={todayIST()} onChange={(e) => setF({ date: e.target.value })} />
        <Input label="Start" type="time" value={f.start} onChange={(e) => setF({ start: e.target.value })} />
        <Input label="End" type="time" value={f.end} onChange={(e) => setF({ end: e.target.value })} error={win.error && f.date ? win.error : undefined} />
        <Button type="submit" disabled={!f.vehicle_id || Boolean(win.error)}>Show track</Button>
      </form>

      {!submitted ? (
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm"><EmptyState title="Choose a vehicle and time window" /></div>
      ) : q.error ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : (
        <>
          <div className="relative">
            <BaseMap className="h-[calc(100vh-380px)] min-h-[420px]">
              <FitToPoints points={line} fitKey={q.data ? key : null} />
              {showPids && dayPids.data && <PidStatusLayer pids={dayPids.data.filter((p) => p.latitude != null)} onSelect={() => {}} />}
              {line.length > 1 && <Polyline positions={line} pathOptions={{ color: MAP_LAYER_COLORS.actualTrail.color, weight: 3 }} />}
              {line.length > 0 && (
                <>
                  <CircleMarker center={line[0]} radius={7} pathOptions={{ color: '#ffffff', weight: 2, fillColor: '#009E73', fillOpacity: 1 }}><Tooltip>Start {formatDateTime(points[0].recorded_at)}</Tooltip></CircleMarker>
                  <CircleMarker center={line[line.length - 1]} radius={7} pathOptions={{ color: '#ffffff', weight: 2, fillColor: '#111111', fillOpacity: 1 }}><Tooltip>End {formatDateTime(points[points.length - 1].recorded_at)}</Tooltip></CircleMarker>
                </>
              )}
              {pos && <CircleMarker center={[pos.lat, pos.lng]} radius={9} pathOptions={{ color: '#ffffff', weight: 2.5, fillColor: MAP_LAYER_COLORS.currentVehicle.color, fillOpacity: 1 }} />}
            </BaseMap>
            {q.loading && <div className="absolute right-3 top-3 z-[400] rounded bg-white/90 px-2 py-1 shadow"><Spinner /></div>}
          </div>
          {q.data && !points.length && <p className="text-sm text-slate-600">No GPS points in this window.</p>}
          {q.data?.downsampled && (
            <p className="text-xs text-slate-500" role="status">Downsampled: showing {points.length} of {q.data.total_in_window} points.</p>
          )}
          {points.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm" aria-label="Playback">
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" onClick={() => dispatch({ type: 'toggle' })} aria-label={pb.playing ? 'Pause' : 'Play'}>{pb.playing ? '❚❚ Pause' : '▶ Play'}</Button>
                <div className="flex gap-1" role="group" aria-label="Playback speed">
                  {SPEEDS.map((s) => (
                    <button key={s} type="button" aria-pressed={pb.speed === s} onClick={() => dispatch({ type: 'speed', value: s })}
                      className={`rounded px-2 py-1 text-xs font-medium ring-1 ${pb.speed === s ? 'bg-emerald-700 text-white ring-emerald-700' : 'ring-slate-300'}`}>{s}×</button>
                  ))}
                </div>
                <span className="text-sm tabular-nums text-slate-700">{pos ? formatDateTime(pos.at) : '—'}</span>
                <span className="text-sm tabular-nums text-slate-500">{pos?.speed != null ? `${pos.speed} km/h` : ''}</span>
                <label className="ml-auto inline-flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={showPids} onChange={(e) => setShowPids(e.target.checked)} disabled={!can('assignments:read')} />
                  Show PIDs of that day&apos;s assignment(s)
                </label>
              </div>
              <input type="range" min={0} max={tl.duration} step={1000} value={pb.playheadMs} aria-label="Playback position"
                onChange={(e) => dispatch({ type: 'scrub', ms: Number(e.target.value) })} className="w-full" />
              <p className="text-xs tabular-nums text-slate-500">{fmtDur(pb.playheadMs)} / {fmtDur(tl.duration)}</p>
              {showPids && <Disclaimer />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
