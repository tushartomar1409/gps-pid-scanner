import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/helpers/globalSetup.js'],
    setupFiles: ['tests/helpers/setupEnv.js'],
    // Integration tests share one throwaway schema on a remote DB; run files sequentially.
    fileParallelism: false,
    // Remote DB (~265 ms per round trip from this machine) makes multi-request tests slow, not hung.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
