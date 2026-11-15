/**
 * Les brouillons d'un projet dont le dossier a été renommé (J12).
 *
 * Un brouillon porte le chemin de son projet et ne se montre que dans lui (Q12). Le dossier renommé
 * dans le Finder, puis le projet rouvert sous son nouveau nom : ses brouillons n'apparaissaient plus
 * nulle part. Ils sont maintenant dans « Brouillons d'autres projets », repliée, d'où « Rattacher à
 * ce projet » les rend au projet ouvert. Renommé par la seule casse, sous macOS, le dossier garde
 * `project.json` à l'ancien chemin : la comparaison des chaînes cachait aussi ses brouillons dans le
 * projet rouvert, et le disque tranche désormais.
 *
 * Vrai chat (un faux Ollama local répond), vrai « Mettre en brouillon », vrai stockage entre deux
 * lancements, vrai renommage sur le disque, vrai `project:locate`.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';
import { startFakeOllama } from './_helpers/fake-ollama';

const ANSWER = 'Réponse du modèle sur les archives de Danzig.';

const toClean: string[] = [];

test.afterEach(() => {
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Un article dans `root/name`. */
function makeProject(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({
      id: '00000000-0000-4000-8000-0000000000d1',
      name: 'Thèse',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'document.md'), '# Thèse\n\nLe port de Danzig en 1934.\n');
  return dir;
}

async function openProject(app: ElectronApplication, window: Page, dir: string): Promise<void> {
  await window.locator('#left-tab-projects').click();
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, join(dir, 'project.json'));
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Le port de Danzig', { timeout: 20_000 });
}

const draftsButton = (window: Page) => window.locator('button[title="Brouillons Brainstorm"]');
const queued = (window: Page) => window.locator('.drafts-panel__list .drafts-panel__card');
const section = (window: Page) => window.locator('details.drafts-panel__others');

/** Le panneau se rouvre tel qu'on l'a laissé (`isPanelOpen` est gardé) : l'ouvrir s'il est fermé. */
async function showDrafts(window: Page): Promise<void> {
  if ((await window.locator('.drafts-panel').count()) === 0) await draftsButton(window).click();
  await expect(window.locator('.drafts-panel')).toBeVisible();
}

/** Premier lancement : le projet, une réponse du chat mise en brouillon, puis l'app quittée. */
async function draftIn(userDataDir: string, dir: string): Promise<boolean> {
  const outcome = await launchApp({ userDataDir });
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return false;
  }
  const { app, window } = outcome.value;
  try {
    await openProject(app, window, dir);
    await window.locator('.right-panel #right-tab-chat').click();
    await window.locator('.right-panel textarea').first().fill('Parle-moi de Danzig');
    await window.keyboard.press('ControlOrMeta+Enter');
    await window.getByRole('button', { name: 'Mettre en brouillon' }).first().click({ timeout: 30_000 });
    await showDrafts(window);
    await expect(queued(window)).toHaveCount(1);
    await expect(queued(window)).toContainText(ANSWER);
  } finally {
    await app.close();
  }
  return true;
}

test('dossier renommé : son brouillon est dans « Brouillons d’autres projets », et « Rattacher à ce projet » le rend au projet rouvert', async () => {
  const ollama = await startFakeOllama(ANSWER);
  toClean.push(ollama.userDataDir);
  const root = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-brouillons-'));
  toClean.push(root);
  const before = makeProject(root, 'These');
  const after = join(root, 'These-2026');

  try {
    if (!(await draftIn(ollama.userDataDir, before))) return;
    renameSync(before, after);

    const outcome = await launchApp({ userDataDir: ollama.userDataDir });
    if (outcome.kind === 'skip') return;
    const { app, window } = outcome.value;
    try {
      await openProject(app, window, after);
      await showDrafts(window);

      await expect(section(window).locator('summary')).toHaveText("Brouillons d'autres projets (1)");
      expect(await section(window).evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
      await expect(queued(window)).toHaveCount(0);
      await section(window).locator('summary').click();
      await expect(section(window)).toContainText(before);
      await expect(section(window)).toContainText(ANSWER);

      await section(window).getByRole('button', { name: 'Rattacher à ce projet' }).click();

      await expect(section(window)).toHaveCount(0);
      await expect(queued(window)).toHaveCount(1);
      await expect(queued(window)).toContainText(ANSWER);
      await expect(draftsButton(window).locator('.toolbar-btn__count')).toHaveText('1');
      // Rien n'a été recréé à l'ancien chemin.
      expect(existsSync(before)).toBe(false);
      expect(readdirSync(root).sort()).toEqual(['These-2026']);
    } finally {
      await app.close();
    }
  } finally {
    await ollama.close();
  }
});

/** Le disque de ce test ignore-t-il la casse (macOS, Windows) ? */
function caseInsensitiveDisk(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-casse-'));
  try {
    writeFileSync(join(dir, 'sonde'), '');
    return existsSync(join(dir, 'SONDE'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('dossier renommé par la seule casse : son brouillon est celui du projet rouvert, pas d’un autre', async () => {
  test.skip(!caseInsensitiveDisk(), 'le disque distingue la casse : deux dossiers, pas un renommage');
  const ollama = await startFakeOllama(ANSWER);
  toClean.push(ollama.userDataDir);
  const root = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-brouillons-casse-'));
  toClean.push(root);
  const before = makeProject(root, 'These');
  const after = join(root, 'these');

  try {
    if (!(await draftIn(ollama.userDataDir, before))) return;
    renameSync(before, after);
    expect(readdirSync(root)).toEqual(['these']);

    const outcome = await launchApp({ userDataDir: ollama.userDataDir });
    if (outcome.kind === 'skip') return;
    const { app, window } = outcome.value;
    try {
      await openProject(app, window, after);

      await expect(draftsButton(window).locator('.toolbar-btn__count')).toHaveText('1');
      await showDrafts(window);
      await expect(queued(window)).toHaveCount(1);
      await expect(queued(window)).toContainText(ANSWER);
      await expect(section(window)).toHaveCount(0);
    } finally {
      await app.close();
    }
  } finally {
    await ollama.close();
  }
});
