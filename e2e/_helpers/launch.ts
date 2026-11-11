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

/** Chargé par `-r` avant le main : les dialogues du démarrage, simulés (voir le module). */
const STARTUP_DIALOGS_STUB = join(HERE, 'stub-startup-dialogs.cjs');

export interface LaunchOptions {
  language?: string;
  /** Un second lancement, qui retrouve les récents du premier ; ou un userData préparé par le test. */
  userDataDir?: string;
  args?: string[];
  /**
   * Les dialogues que le main pose dans `whenReady`, avant que le pilote puisse appeler
   * `app.evaluate` (fichier de réglages mis de côté, réglages illisibles) : simulés dès le
   * lancement, et inscrits pour `startupDialogs`.
   */
  startupDialogs?: boolean;
}

/** Ce qu'un dialogue du démarrage a montré. */
export type StartupDialogSeen =
  | { kind: 'message'; type?: string; message: string; detail?: string }
  | { kind: 'error'; title: string; content: string };

const startupDialogsLog = (userDataDir: string) => join(userDataDir, 'e2e-startup-dialogs.jsonl');

export function startupDialogs(userDataDir: string): StartupDialogSeen[] {
  const logFile = startupDialogsLog(userDataDir);
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as StartupDialogSeen);
}

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
export async function launchApp(options: LaunchOptions = {}): Promise<LaunchOutcome> {
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

  const app = await startElectron(userDataDir, options);

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

/**
 * Le lancement seul, sans attendre de fenêtre : pour une app qui doit sortir sans en ouvrir
 * (réglages illisibles). `launchApp` l'emploie.
 */
export async function startElectron(userDataDir: string, options: LaunchOptions = {}): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  }
  if (options.startupDialogs) env.CLIODECK_E2E_STARTUP_DIALOGS = startupDialogsLog(userDataDir);

  return electron.launch({
    cwd: REPO_ROOT,
    // `--use-mock-keychain` : un test qui enregistre une clé d'API ne touche pas au vrai trousseau.
    // `-r` avant l'app : le module est chargé avant son main.
    args: [
      ...(options.startupDialogs ? ['-r', STARTUP_DIALOGS_STUB] : []),
      '.',
      '--no-sandbox',
      '--use-mock-keychain',
      `--user-data-dir=${userDataDir}`,
      ...(options.args ?? []),
    ],
    env,
    timeout: 30_000,
  });
}

/** Une question native posée pendant le test, et ce que le bouchon y a répondu. */
export interface LeaveDialogSeen {
  message: string;
  buttons: string[];
  response: number;
}

interface LeaveDialogStub {
  __leaveAnswer: number;
}

/** « Quitter sans enregistrer » dans chaque langue, lu dans les fichiers que lit le main (`unsavedLeave`). */
const LEAVE_LABELS = ['fr', 'en', 'de'].map(
  (language) =>
    (JSON.parse(readFileSync(join(REPO_ROOT, 'public', 'locales', language, 'menu.json'), 'utf8')) as Record<string, string>)
      .unsavedLeave,
);

const leaveDialogLogs = new WeakMap<ElectronApplication, string>();

/**
 * Un tampon sans titre non vide, ou une écriture refusée, pose une question native à
 * la fermeture. Personne n'y répondrait : `app.close()` resterait bloqué, et la suite
 * avec lui, y compris quand un test échoue en plein milieu. Le dialogue répond donc
 * « Quitter sans enregistrer » par défaut ; `answerLeaveDialog` change la réponse.
 *
 * À cette question-là seulement, reconnue à son bouton dans les trois langues : le
 * consentement à un envoi distant (`confirmCloudUsage`) et l'ajout d'un serveur MCP
 * (`confirmMcpAdd`) passent aussi par `showMessageBox`, et leur bouton 1 accepte. Toute
 * autre question reçoit `cancelId` (0 s'il manque), comme un dialogue qu'on ferme.
 *
 * `leaveDialogs` dit chaque question posée et la réponse donnée. Elles s'écrivent dans un
 * fichier, lu côté test : sous Windows et Linux, la dernière fenêtre fermée emporte l'app, et
 * il n'y aurait plus personne à interroger. `E2E_DIALOG_JOURNAL` nomme en plus un fichier où
 * une suite entière les garde.
 */
async function stubLeaveDialog(app: ElectronApplication, logFile: string): Promise<void> {
  leaveDialogLogs.set(app, logFile);
  const files = process.env.E2E_DIALOG_JOURNAL ? [logFile, process.env.E2E_DIALOG_JOURNAL] : [logFile];
  await app.evaluate(
    ({ dialog }, { files, leaveLabels }) => {
      const { appendFileSync } = process.getBuiltinModule('node:fs');
      const stub = globalThis as unknown as LeaveDialogStub;
      stub.__leaveAnswer = 1;
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (...args: unknown[]) => {
        const { message, buttons, cancelId } = args[args.length - 1] as Partial<LeaveDialogSeen> & { cancelId?: number };
        const leave = buttons !== undefined && leaveLabels.includes(buttons[1]);
        const response = leave ? stub.__leaveAnswer : (cancelId ?? 0);
        const line = `${JSON.stringify({ message, buttons, response })}\n`;
        for (const file of files) appendFileSync(file, line);
        return { response, checkboxChecked: false };
      };
    },
    { files, leaveLabels: LEAVE_LABELS },
  );
}

/** La réponse à la question de sortie, et à elle seule. */
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
