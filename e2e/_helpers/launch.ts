/**
 * Electron launch helper for Playwright smoke tests.
 *
 * Encapsulates the two reasons these tests may not be runnable:
 *   1. No display server available (typical in CI sandboxes without Xvfb).
 *   2. The app hasn't been built yet — Playwright needs the compiled
 *      main-process entry point.
 *
 * In both cases we return `null`; the caller is expected to `test.skip()`
 * (or fail with a clear message for the missing-build case).
 */

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LaunchResult {
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
}

export type LaunchOutcome =
  | { kind: 'ok'; value: LaunchResult }
  | { kind: 'skip'; reason: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const MAIN_ENTRY = join(REPO_ROOT, 'dist', 'src', 'main', 'index.js');

export function shouldSkip(): string | null {
  if (process.env.CI === 'true' && !process.env.DISPLAY) {
    return 'No DISPLAY in CI sandbox — Electron cannot open a window.';
  }
  if (!existsSync(MAIN_ENTRY)) {
    return `Missing ${MAIN_ENTRY}. Run "npm run build" before the E2E suite.`;
  }
  return null;
}

/**
 * Launch the packaged-but-unbundled app the same way `npm start` does.
 *
 * `ELECTRON_RUN_AS_NODE` is explicitly cleared: if it leaks in from the
 * parent shell, Electron boots as a plain Node process and no window
 * ever appears.
 *
 * A fresh `userData` dir is created under the OS tmp tree so the tests
 * never touch `~/.config/cliodeck`. The caller receives the path so it
 * can clean up on teardown.
 */
export async function launchApp(): Promise<LaunchOutcome> {
  const skip = shouldSkip();
  if (skip) return { kind: 'skip', reason: skip };

  const userDataDir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-'));

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  }

  const app = await electron.launch({
    cwd: REPO_ROOT,
    args: ['.', '--no-sandbox', `--user-data-dir=${userDataDir}`],
    env,
    timeout: 30_000,
  });

  const window = await app.firstWindow({ timeout: 30_000 });
  await window.waitForLoadState('domcontentloaded');

  return { kind: 'ok', value: { app, window, userDataDir } };
}
