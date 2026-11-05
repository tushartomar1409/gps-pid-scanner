// Recharts lives only in this module (own chunk via manualChunks). Light mode only: the app has no dark theme.
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, LabelList, ComposedChart,
} from 'recharts';
import { VISIT_STATUS, MAP_LAYER_COLORS } from '../../utils/visitStatus.js';
import { COVERAGE_LABELS } from '../../utils/disclaimer.js';

const AXIS = { fontSize: 11, fill: '#475569' };
const GRID = '#e2e8f0';

/** grouped rows -> stacked bar data (not visited = assigned − confirmed − candidate − unavailable). */
export function toStacked(groups = []) {
  return groups.map((g) => ({
    name: g.group_name,
    confirmed: g.confirmed,
    candidate: g.candidate,
    not_visited: Math.max(0, g.assigned - g.confirmed - g.candidate - g.unavailable),
    unavailable: g.unavailable,
    pctLabel: g.confirmed_pct === null ? '' : `${g.confirmed_pct}%`,
  }));
}

const STACK = [
  ['confirmed', VISIT_STATUS.GPS_VISIT_CONFIRMED],
  ['candidate', VISIT_STATUS.GPS_VISIT_CANDIDATE],
  ['not_visited', VISIT_STATUS.NOT_VISITED],
  ['unavailable', VISIT_STATUS.GPS_DATA_UNAVAILABLE],
];

export function CoverageStackedBars({ groups, height = 280 }) {
  const data = toStacked(groups);
  return (
    <div style={{ height }} role="img" aria-label="Coverage by status, stacked">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 18, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="name" tick={AXIS} interval={0} angle={data.length > 6 ? -30 : 0} textAnchor={data.length > 6 ? 'end' : 'middle'} height={data.length > 6 ? 60 : 30} />
          <YAxis tick={AXIS} allowDecimals={false} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {STACK.map(([k, s], i) => (
            <Bar key={k} dataKey={k} stackId="s" name={`${s.symbol} ${s.label}`} fill={s.color} isAnimationActive={false}>
              {i === STACK.length - 1 && <LabelList dataKey="pctLabel" position="top" style={{ fontSize: 11, fill: '#0f172a' }} />}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function AgencyBars({ groups, height = 260 }) {
  const data = groups.map((g) => ({ name: g.group_name, confirmed_pct: g.confirmed_pct ?? 0, detected_pct: g.detected_pct ?? 0 }));
  return (
    <div style={{ height }} role="img" aria-label="Agency performance">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="name" tick={AXIS} />
          <YAxis tick={AXIS} domain={[0, 100]} unit="%" />
          <Tooltip formatter={(v) => `${v}%`} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="confirmed_pct" name={COVERAGE_LABELS.confirmedPct} fill={VISIT_STATUS.GPS_VISIT_CONFIRMED.color} isAnimationActive={false} />
          <Bar dataKey="detected_pct" name={COVERAGE_LABELS.detectedPct} fill={VISIT_STATUS.GPS_VISIT_CANDIDATE.color} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TrendLines({ days, height = 260 }) {
  const data = days.map((d) => ({ date: d.date.slice(5), confirmed_pct: d.confirmed_pct, detected_pct: d.detected_pct }));
  return (
    <div style={{ height }} role="img" aria-label="Daily coverage trend">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
          <CartesianGrid stroke={GRID} />
          <XAxis dataKey="date" tick={AXIS} />
          <YAxis tick={AXIS} domain={[0, 100]} unit="%" />
          <Tooltip formatter={(v) => (v === null ? 'no assignments' : `${v}%`)} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="confirmed_pct" name={COVERAGE_LABELS.confirmedPct} stroke={VISIT_STATUS.GPS_VISIT_CONFIRMED.color} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="detected_pct" name={COVERAGE_LABELS.detectedPct} stroke="#b38f00" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 3, strokeWidth: 0 }} connectNulls={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HourlyChart({ hours, height = 240 }) {
  return (
    <div style={{ height }} role="img" aria-label="Hourly GPS activity">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={hours} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="hour" tick={AXIS} tickFormatter={(h) => String(h).padStart(2, '0')} />
          <YAxis yAxisId="g" tick={AXIS} allowDecimals={false} />
          <YAxis yAxisId="e" orientation="right" tick={AXIS} allowDecimals={false} />
          <Tooltip labelFormatter={(h) => `${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59 IST`} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar yAxisId="g" dataKey="gps_points" name="GPS points" fill={MAP_LAYER_COLORS.currentVehicle.color} isAnimationActive={false} />
          <Line yAxisId="e" dataKey="visit_events" name="GPS visit events" stroke={MAP_LAYER_COLORS.actualTrail.color} strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
