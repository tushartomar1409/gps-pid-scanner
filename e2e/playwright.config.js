// npm run e2e (from the repo root). Specs are numbered and run in order on ONE worker: later specs use the
// data earlier ones create (import -> route -> assignment -> live/coverage -> export).
import { defineConfig } from '@playwright/test';
import { WEB } from './global-setup.js';

export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.js',
  globalTeardown: './global-teardown.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['json', { outputFile: '.state/results.json' }]],
  outputDir: '.state/artifacts',
  use: {
    baseURL: WEB,
    channel: 'chrome', // the installed Google Chrome, headless (no browser download)
    headless: true,
    viewport: { width: 1440, height: 900 },
    timezoneId: 'Asia/Kolkata',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
