import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

// Never open a real socket in unit tests: a minimal fake io() that records calls.
vi.mock('socket.io-client', () => {
  const make = () => {
    const handlers = {};
    return {
      handlers,
      io: { on: vi.fn() },
      on: vi.fn((ev, fn) => { handlers[ev] = fn; }),
      onAny: vi.fn(),
      offAny: vi.fn(),
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(),
    };
  };
  return { io: vi.fn(() => make()) };
});
