/**
 * Quitter l'application ferme la séance : sa session a une fin et une durée, et le dernier
 * événement d'usage est écrit (L03-9 ; S11-1-6).
 *
 * `before-quit` vidait l'éditeur puis appelait `app.exit()`, qui ne ferme aucun service : la session
 * du journal de recherche restait « Active » à vie, et les événements du journal d'usage encore en
 * tampon (750 ms) se perdaient. Cmd+Q est la façon ordinaire de finir une journée.
 *
 * Vrai éditeur, vrai chat (un faux Ollama local répond), vrai projet dans un dossier temporaire.
 * Cmd+Q est `app.quit()`, ce que fait le rôle `quit` du menu : jamais un vrai raccourci clavier.
 * Les bases se lisent après coup, en lecture seule, par le Node d'Electron.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './_helpers/launch';
import { startFakeOllama } from './_helpers/fake-ollama';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTICLE = '# Séance\n\nLe préfet et la grève de 1934.\n';
const PHRASE = ' Une phrase de fin de journée.';
const QUESTION = 'Qui était le préfet en 1934 ?';
const ANSWER = 'Le préfet était en poste depuis 1931.';

const toClean: string[] = [];

test.afterEach(() => {
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeArticle(root: string): { dir: string; projectJson: string; document: string } {
  const dir = join(root, 'Seance');
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000391',
      name: 'Séance',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const document = join(dir, 'document.md');
  writeFileSync(document, ARTICLE);
  return { dir, projectJson, document };
}

/** Une requête en lecture seule, par le Node d'Electron, sur une base que l'app a fermée. */
function query<T>(dbPath: string, sql: string): T[] {
  const script = `
    const Database = require('better-sqlite3');
    const [file, sql] = process.argv.slice(1);
    const db = new Database(file, { readonly: true, fileMustExist: true });
    process.stdout.write(JSON.stringify(db.prepare(sql).all()));
    db.close();
  `;
  const electronPath = createRequire(import.meta.url)('electron') as string;
  const out = execFileSync(electronPath, ['-e', script, dbPath, sql], {
    cwd: REPO_ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'pipe',
  });
  return JSON.parse(out.toString()) as T[];
}

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Le préfet', { timeout: 20_000 });
}

/** Cmd+Q : ce que fait le rôle `quit` du menu. */
const quit = (app: ElectronApplication) =>
  app.evaluate(({ app: electronApp }) => {
    electronApp.quit();
  });

test('quitter clôt la séance : fin et durée au Journal, dernier événement d’usage écrit', async () => {
  test.setTimeout(150_000);
  const root = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-sortie-'));
  toClean.push(root);
  const article = makeArticle(root);
  const ollama = await startFakeOllama(ANSWER);
  toClean.push(ollama.userDataDir);

  try {
    // Première séance : écrire, enregistrer, poser une question, puis quitter aussitôt la réponse reçue.
    const first = await launchApp({ userDataDir: ollama.userDataDir });
    if (first.kind === 'skip') {
      test.skip(true, first.reason);
      return;
    }
    const { app, window } = first.value;
    let exitedMs = Number.POSITIVE_INFINITY;
    try {
      await openProject(app, window, article.projectJson);
      const editor = window.locator('.codemirror-editor .cm-content');
      await editor.click();
      await window.keyboard.press('ControlOrMeta+End');
      await window.keyboard.type(PHRASE);
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.send('menu:save-file');
      });
      await expect.poll(() => readFileSync(article.document, 'utf8'), { timeout: 10_000 }).toContain(PHRASE.trim());

      await window.locator('.right-panel #right-tab-chat').click();
      await window.locator('.right-panel textarea').first().fill(QUESTION);
      await window.keyboard.press('ControlOrMeta+Enter');
      await expect(window.locator('.right-panel')).toContainText(ANSWER, { timeout: 30_000 });

      const exited = app.waitForEvent('close');
      const quitAt = Date.now();
      await quit(app);
      await exited;
      exitedMs = Date.now() - quitAt;
    } finally {
      await app.close().catch(() => undefined);
    }
    // Le flush de l'éditeur (4 s au plus) puis l'arrêt des services (8 s au plus) : bien moins ici.
    expect(exitedMs).toBeLessThan(10_000);

    // Sur le disque, avant toute réouverture : la séance est close, et le tour de chat est au journal.
    const brainDb = join(article.dir, '.cliodeck', 'brain.db');
    const sessions = query<{ ended_at: string | null; total_duration_ms: number | null }>(
      brainDb,
      'SELECT ended_at, total_duration_ms FROM history_sessions',
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ended_at).not.toBeNull();
    expect(sessions[0].total_duration_ms).not.toBeNull();
    const completions = query<{ n: number }>(
      join(article.dir, '.cliodeck', 'journal.db'),
      "SELECT COUNT(*) AS n FROM inference_events WHERE kind = 'completion'",
    );
    expect(completions[0].n).toBeGreaterThanOrEqual(1);

    // Seconde séance, même userData, même projet : le Journal ne montre « Active » que la séance en cours.
    const second = await launchApp({ userDataDir: ollama.userDataDir });
    if (second.kind === 'skip') {
      test.skip(true, second.reason);
      return;
    }
    const { app: app2, window: window2 } = second.value;
    try {
      await openProject(app2, window2, article.projectJson);
      await window2.locator('.right-panel #right-tab-journal').click();
      // La séance en cours n'a encore aucun événement : sans cette case, elle serait masquée.
      await window2.locator('.right-panel .hide-empty-checkbox input').uncheck();
      const durations = window2.locator('.right-panel .session-card .session-duration');
      await expect(durations).toHaveCount(2, { timeout: 15_000 });
      // La plus récente d'abord : la séance en cours, seule « Active » ; la précédente a sa durée.
      await expect(durations.nth(0)).toHaveText('Active');
      await expect(durations.nth(1)).toHaveText(/^\d+ min$/);
    } finally {
      await app2.close().catch(() => undefined);
    }
  } finally {
    await ollama.close();
  }
});
