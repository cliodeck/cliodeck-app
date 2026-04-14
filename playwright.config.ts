import { defineConfig } from '@playwright/test';

/**
 * Playwright config for Electron end-to-end smoke tests.
 *
 * Workers are pinned to 1 because the Electron app uses a single
 * user-data directory and parallel runs would race on it.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 1,
  reporter: 'list',
  workers: 1,
  use: {
    trace: 'on-first-retry',
  },
});
