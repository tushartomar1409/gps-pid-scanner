// GUIDE #9 G4: history playback — real-time scaling, pause, scrub, interpolation (pure logic).
import { describe, it, expect } from 'vitest';
import { historyWindow, indexAt, initialPlayback, playbackReducer, positionAt, timeline } from '../pages/history/playback.js';

// Uneven sampling: 0 s, 10 s, 70 s, 130 s — playback must follow TIME, not point index.
const PTS = [0, 10, 70, 130].map((s, i) => ({ latitude: 28 + i, longitude: 77, speed: i * 10, recorded_at: new Date(Date.UTC(2031, 0, 1, 4, 0, s)).toISOString() }));
const tl = timeline(PTS);
const run = (state, ...actions) => actions.reduce((s, a) => playbackReducer(s, a, tl.duration), state);

describe('playback', () => {
  it('timeline duration is real elapsed time', () => {
    expect(tl.duration).toBe(130_000);
  });

  it('ticks advance by wall-clock delta × speed; ends and stops at the last point', () => {
    let s = run(initialPlayback, { type: 'speed', value: 20 }, { type: 'play' });
    expect(s.playing).toBe(true);
    s = run(s, { type: 'tick', dtMs: 1000 }); // 1 s wall × 20 = 20 s of track time
    expect(s.playheadMs).toBe(20_000);
    expect(positionAt(PTS, tl, s.playheadMs).index).toBe(1); // past the 10 s point, before 70 s
    s = run(s, { type: 'speed', value: 60 }, { type: 'tick', dtMs: 1000 }); // +60 s
    expect(s.playheadMs).toBe(80_000);
    expect(positionAt(PTS, tl, s.playheadMs).index).toBe(2);
    s = run(s, { type: 'tick', dtMs: 10_000 });
    expect(s).toMatchObject({ playheadMs: 130_000, playing: false });
    expect(run(s, { type: 'play' }).playheadMs).toBe(0); // play at the end restarts
  });

  it('pause stops ticks; scrub clamps to [0, duration]; invalid speeds ignored', () => {
    let s = run(initialPlayback, { type: 'play' }, { type: 'tick', dtMs: 500 }, { type: 'pause' });
    const at = s.playheadMs;
    s = run(s, { type: 'tick', dtMs: 5000 });
    expect(s.playheadMs).toBe(at);
    expect(run(s, { type: 'scrub', ms: 999_999 }).playheadMs).toBe(130_000);
    expect(run(s, { type: 'scrub', ms: -5 }).playheadMs).toBe(0);
    expect(run(s, { type: 'speed', value: 7 }).speed).toBe(s.speed);
    expect(run(s, { type: 'toggle' }).playing).toBe(true);
  });

  it('positionAt interpolates linearly between the surrounding points', () => {
    const p = positionAt(PTS, tl, 40_000); // halfway between 10 s and 70 s
    expect(p.index).toBe(1);
    expect(p.lat).toBeCloseTo(29.5, 6);
    expect(p.at.toISOString()).toBe(new Date(Date.UTC(2031, 0, 1, 4, 0, 40)).toISOString());
    expect(positionAt([], timeline([]), 0)).toBeNull();
    expect(indexAt(tl.ts, tl.ts[3] + 1)).toBe(3);
  });

  it('history window is IST, 00:00–23:59 by default, end after start', () => {
    expect(historyWindow('2031-01-01')).toEqual({ from: '2031-01-01T00:00:00+05:30', to: '2031-01-01T23:59:59+05:30' });
    expect(historyWindow('2031-01-01', '10:00', '09:00').error).toMatch(/after/);
    expect(historyWindow('').error).toBeTruthy();
  });
});
