/**
 * Changer de projet repart de zéro : dans le projet B, rien de la bibliographie ni de la
 * conversation du projet A (L03-4 ; S07-1-31, S16-1-22). Revenir à A rend sa bibliographie, pas sa
 * conversation (décision Q11 : la conversation conservée par projet viendra après la rc.6).
 *
 * Avant, le panneau Bibliographie de B, créé sans `.bib`, listait les références de A, et la
 * question posée dans A restait affichée dans B, prête à repartir en historique au tour suivant.
 * Vrais boutons, vrai chat (un faux Ollama local répond), vrais projets dans des dossiers
 * temporaires.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';
import { startFakeOllama } from './_helpers/fake-ollama';

const ANSWER = 'Le préfet de Danzig était en poste depuis 1931.';
const QUESTION = 'Qui était le préfet en 1934 ?';
const REFERENCE = 'Le préfet et la grève';

const toClean: string[] = [];

test.afterEach(() => {
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Le projet A, sur le disque : un article et son `.bib`. */
function makeProjectA(root: string): string {
  const dir = join(root, 'These');
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({
      id: '00000000-0000-4000-8000-0000000000a4',
      name: 'Thèse',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bibliographySource: { type: 'file', filePath: 'a.bib' },
    }),
  );
  writeFileSync(join(dir, 'document.md'), '# Thèse\n\nLe préfet et la grève de 1934.\n');
  writeFileSync(
    join(dir, 'a.bib'),
    `@book{Dupont_1990,\n  author = {Dupont, Jean},\n  title = {${REFERENCE}},\n  year = {1990},\n  publisher = {PUF}\n}\n`,
  );
  return join(dir, 'project.json');
}

async function openProject(app: ElectronApplication, window: Page, projectJson: string, title: string): Promise<void> {
  await window.locator('#left-tab-projects').click();
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText(title, { timeout: 20_000 });
}

/** Dialogue de dossier simulé, vraie modale, accompagnement fermé. */
async function createProject(app: ElectronApplication, window: Page, parent: string, name: string): Promise<void> {
  await window.locator('#left-tab-projects').click();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, parent);
  await window.locator('button[title="Nouveau projet"]').first().click();
  await window.locator('.create-project-content select').selectOption('article');
  await window.locator('.create-project-content input[type="text"]').first().fill(name);
  await window.locator('.create-project-content .path-selector button').click();
  await expect(window.locator('.create-project-content .path-selector input')).toHaveValue(parent);
  await window.locator('.create-project-content .btn-submit').click();
  await expect(window.locator('.create-project-content')).toHaveCount(0, { timeout: 20_000 });
  await window.locator('.onboarding-wizard__close').click();
  await expect(window.locator('.onboarding-wizard')).toHaveCount(0);
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText(name, { timeout: 20_000 });
}

const bibliographyCards = (window: Page) => window.locator('#left-tabpanel-bibliography .citation-card');
const chat = (window: Page) => window.locator('.right-panel');

async function showBibliography(window: Page): Promise<void> {
  await window.locator('#left-tab-bibliography').click();
}

test('B sans .bib, après A : ni bibliographie ni conversation de A ; revenir à A rend sa bibliographie', async () => {
  test.setTimeout(150_000);
  const root = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-bascule-'));
  toClean.push(root);
  const projectA = makeProjectA(root);
  const ollama = await startFakeOllama(ANSWER);
  toClean.push(ollama.userDataDir);
  const outcome = await launchApp({ userDataDir: ollama.userDataDir });
  if (outcome.kind === 'skip') {
    await ollama.close();
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window } = outcome.value;

  try {
    await openProject(app, window, projectA, 'Thèse');
    await showBibliography(window);
    await expect(bibliographyCards(window).filter({ hasText: REFERENCE })).toHaveCount(1, { timeout: 20_000 });

    // Une vraie question au vrai chat, dans A.
    await window.locator('.right-panel #right-tab-chat').click();
    await chat(window).locator('textarea').first().fill(QUESTION);
    await window.keyboard.press('ControlOrMeta+Enter');
    await expect(chat(window)).toContainText(ANSWER, { timeout: 30_000 });

    await createProject(app, window, root, 'Article');

    await showBibliography(window);
    await expect(bibliographyCards(window)).toHaveCount(0);
    await expect(window.locator('#left-tabpanel-bibliography')).not.toContainText(REFERENCE);
    await expect(chat(window)).not.toContainText(QUESTION);
    await expect(chat(window)).not.toContainText(ANSWER);

    // Retour à A : sa bibliographie revient, la conversation reste vidée (Q11).
    await openProject(app, window, projectA, 'Thèse');
    await showBibliography(window);
    await expect(bibliographyCards(window).filter({ hasText: REFERENCE })).toHaveCount(1, { timeout: 20_000 });
    await expect(chat(window)).not.toContainText(QUESTION);
  } finally {
    await app.close().catch(() => undefined);
    await ollama.close();
  }
});
