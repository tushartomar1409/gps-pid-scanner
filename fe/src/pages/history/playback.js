// History playback as pure logic (GUIDE #9 E3): the marker moves in REAL time order scaled by speed,
// not one step per point. Playhead = ms offset from the first point.

export const SPEEDS = [1, 5, 20, 60];

export function timeline(points) {
  const ts = points.map((p) => new Date(p.recorded_at).getTime());
  return { ts, start: ts[0] ?? 0, duration: ts.length ? ts[ts.length - 1] - ts[0] : 0 };
}

export const initialPlayback = { playheadMs: 0, playing: false, speed: 20 };

/**
 * actions: play | pause | toggle | tick {dtMs (wall clock)} | scrub {ms} | speed {value} | reset
 * `duration` comes from the current timeline.
 */
export function playbackReducer(state, action, duration) {
  switch (action.type) {
    case 'play':
      return { ...state, playing: duration > 0, playheadMs: state.playheadMs >= duration ? 0 : state.playheadMs };
    case 'pause':
      return { ...state, playing: false };
    case 'toggle':
      return playbackReducer(state, { type: state.playing ? 'pause' : 'play' }, duration);
    case 'tick': {
      if (!state.playing) return state;
      const next = state.playheadMs + action.dtMs * state.speed;
      return next >= duration ? { ...state, playheadMs: duration, playing: false } : { ...state, playheadMs: next };
    }
    case 'scrub':
      return { ...state, playheadMs: Math.min(Math.max(0, action.ms), duration) };
    case 'speed':
      return SPEEDS.includes(action.value) ? { ...state, speed: action.value } : state;
    case 'reset':
      return { ...initialPlayback, speed: state.speed };
    default:
      return state;
  }
}

/** Binary search: last index with ts <= t. */
export function indexAt(ts, t) {
  let lo = 0;
  let hi = ts.length - 1;
  if (hi < 0) return -1;
  if (t <= ts[0]) return 0;
  if (t >= ts[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Interpolated position at playhead (linear between the surrounding points). */
export function positionAt(points, tl, playheadMs) {
  if (!points.length) return null;
  const t = tl.start + playheadMs;
  const i = indexAt(tl.ts, t);
  const a = points[i];
  const b = points[i + 1];
  if (!b || tl.ts[i + 1] === tl.ts[i]) {
    return { index: i, lat: a.latitude, lng: a.longitude, speed: a.speed, at: new Date(t) };
  }
  const f = (t - tl.ts[i]) / (tl.ts[i + 1] - tl.ts[i]);
  return {
    index: i,
    lat: a.latitude + (b.latitude - a.latitude) * f,
    lng: a.longitude + (b.longitude - a.longitude) * f,
    speed: a.speed,
    at: new Date(t),
  };
}

/** IST window for a date + HH:mm inputs, capped at 24 h. Returns { from, to } ISO with +05:30 or { error }. */
export function historyWindow(date, startHHmm = '00:00', endHHmm = '23:59') {
  if (!date) return { error: 'Pick a date' };
  const from = `${date}T${startHHmm}:00+05:30`;
  const to = `${date}T${endHHmm}:59+05:30`;
  if (new Date(to) <= new Date(from)) return { error: 'End time must be after start time' };
  return { from, to };
}
