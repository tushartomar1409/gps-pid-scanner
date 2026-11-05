import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBboxQuery } from '../hooks/useBboxQuery.js';

vi.mock('../api/resources.js', () => ({ pidsApi: { map: vi.fn() } }));

describe('useBboxQuery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces bursts of bbox changes into one request with the latest bbox', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: { points: [{ id: 1 }], truncated: false, count: 1 } });
    const { result } = renderHook(() => useBboxQuery({ ward_id: '7' }, { fetcher }));

    act(() => result.current.setBbox('1,1,2,2'));
    act(() => { vi.advanceTimersByTime(100); });
    act(() => result.current.setBbox('1,1,3,3'));
    act(() => { vi.advanceTimersByTime(299); });
    expect(fetcher).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(1); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toEqual({ ward_id: '7', bbox: '1,1,3,3', limit: 5000 });
    await act(async () => {});
    expect(result.current.points).toEqual([{ id: 1 }]);
  });

  it('aborts the in-flight request when a newer bbox arrives and ignores its result', async () => {
    const signals = [];
    let resolveFirst;
    const fetcher = vi.fn((_params, { signal }) => {
      signals.push(signal);
      if (signals.length === 1) return new Promise((r) => { resolveFirst = r; });
      return Promise.resolve({ data: { points: [{ id: 2 }], truncated: true, count: 1 } });
    });
    const { result } = renderHook(() => useBboxQuery({}, { fetcher }));

    act(() => result.current.setBbox('a'));
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => result.current.setBbox('b'));
    expect(signals[0].aborted).toBe(true);
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { resolveFirst({ data: { points: [{ id: 1 }], truncated: false, count: 1 } }); });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.points).toEqual([{ id: 2 }]);
    expect(result.current.truncated).toBe(true);
  });

  it('does nothing until a bbox is known', () => {
    const fetcher = vi.fn();
    renderHook(() => useBboxQuery({}, { fetcher }));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
