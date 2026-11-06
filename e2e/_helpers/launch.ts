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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Langue de l'interface pendant les tests : les libellés attendus en dépendent. */
export const E2E_LANGUAGE = 'fr';

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
export async function launchApp(
  options: { language?: string; userDataDir?: string; args?: string[] } = {},
): Promise<LaunchOutcome> {
  const skip = shouldSkip();
  if (skip) return { kind: 'skip', reason: skip };

  // `options.userDataDir` : un second lancement, qui retrouve les récents du premier.
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'cliodeck-e2e-'));

  // Langue fixée avant le premier rendu : sans réglage, l'app suit la langue
  // du système, et tout test écrit sur un libellé devient dépendant du poste.
  // On fixe le français, le défaut de l'app. `cliodeck-config.json` est le
  // fichier electron-store, lu au démarrage dans le userData créé ci-dessus.
  if (!options.userDataDir) {
    writeFileSync(
      join(userDataDir, 'cliodeck-config.json'),
      JSON.stringify({ language: options.language ?? E2E_LANGUAGE }),
    );
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  }

  const app = await electron.launch({
    cwd: REPO_ROOT,
    // `--use-mock-keychain` : un test qui enregistre une clé d'API ne touche pas au vrai trousseau.
    args: ['.', '--no-sandbox', '--use-mock-keychain', `--user-data-dir=${userDataDir}`, ...(options.args ?? [])],
    env,
    timeout: 30_000,
  });

  const window = await app.firstWindow({ timeout: 30_000 });
  // Depuis Electron 45, la première page rendue est le document vide de la
  // fenêtre, avant que `loadFile` ne charge l'app : attendre son seul
  // `domcontentloaded` rendait la main avant le montage de React, et un
  // événement envoyé aussitôt (`show-settings-modal`) se perdait.
  await window.waitForURL((url) => url.protocol === 'file:' || url.protocol.startsWith('http'), {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await stubLeaveDialog(app, join(userDataDir, 'e2e-leave-dialogs.jsonl'));

  return { kind: 'ok', value: { app, window, userDataDir } };
}

/** Ce que le dialogue natif de sortie a demandé à l'auteur. */
export interface LeaveDialogSeen {
  message: string;
  buttons: string[];
}

interface LeaveDialogStub {
  __leaveAnswer: number;
}

const leaveDialogLogs = new WeakMap<ElectronApplication, string>();

/**
 * Un tampon sans titre non vide, ou une écriture refusée, pose une question native à
 * la fermeture. Personne n'y répondrait : `app.close()` resterait bloqué, et la suite
 * avec lui, y compris quand un test échoue en plein milieu. Le dialogue répond donc
 * « Quitter sans enregistrer » par défaut ; `answerLeaveDialog` change la réponse et
 * `leaveDialogs` dit ce qui a été demandé.
 *
 * Ce qui a été demandé s'écrit dans un fichier, lu côté test : sous Windows et Linux, la
 * dernière fenêtre fermée emporte l'app, et il n'y aurait plus personne à interroger.
 */
async function stubLeaveDialog(app: ElectronApplication, logFile: string): Promise<void> {
  leaveDialogLogs.set(app, logFile);
  await app.evaluate(({ dialog }, file) => {
    const { appendFileSync } = process.getBuiltinModule('node:fs');
    const stub = globalThis as unknown as LeaveDialogStub;
    stub.__leaveAnswer = 1;
    (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (...args: unknown[]) => {
      const { message, buttons } = args[args.length - 1] as LeaveDialogSeen;
      appendFileSync(file, `${JSON.stringify({ message, buttons })}\n`);
      return { response: stub.__leaveAnswer, checkboxChecked: false };
    };
  }, logFile);
}

export function answerLeaveDialog(app: ElectronApplication, answer: 'stay' | 'leave'): Promise<void> {
  return app.evaluate((_electron, response) => {
    (globalThis as unknown as LeaveDialogStub).__leaveAnswer = response;
  }, answer === 'stay' ? 0 : 1);
}

export async function leaveDialogs(app: ElectronApplication): Promise<LeaveDialogSeen[]> {
  const logFile = leaveDialogLogs.get(app);
  if (!logFile) throw new Error('Cette app n’a pas été lancée par launchApp.');
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as LeaveDialogSeen);
}
