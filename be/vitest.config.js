import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/helpers/globalSetup.js'],
    setupFiles: ['tests/helpers/setupEnv.js'],
    // GUIDE #11 B2: each test file in its own child process (forks) — a native crash (seen once on Windows,
    // 0xC0000409) then kills one worker, not the run. Files stay sequential: they share one throwaway
    // schema on a remote DB, so file parallelism (maxWorkers > 1) would let fixtures collide.
    pool: 'forks',
    fileParallelism: false,
    // Remote DB (~265 ms per round trip from this machine) makes multi-request tests slow, not hung.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
