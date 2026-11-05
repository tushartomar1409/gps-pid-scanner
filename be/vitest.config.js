import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/helpers/globalSetup.js'],
    setupFiles: ['tests/helpers/setupEnv.js'],
    // Integration tests share one throwaway schema on a remote DB; run files sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
