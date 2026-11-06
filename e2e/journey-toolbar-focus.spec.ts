/**
 * La barre d'outils de l'éditeur laisse le focus au texte (D5), et la barre d'état d'un document
 * tout juste ouvert dit « Non modifié » (D6).
 *
 * Après un clic sur Enregistrer, Cmd+B ne faisait rien avant un clic dans le texte, et une espace
 * relançait l'enregistrement. Vrais clics, vraies frappes vers la page (jamais vers le système).
 * Un renommage de chapitre en cours ne se perd pas : un clic sur la barre ne le termine plus, il
 * se termine à Entrée.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';

const ARTICLE = '# Article\n\nHuit mille mots déjà enregistrés.\n';
const LAST_WORD = 'enregistrés';

const editor = (window: Page) => window.locator('.codemirror-editor .cm-content');
const saveButton = (window: Page) => window.locator('.editor-toolbar button[title="Enregistrer"]');
const status = (window: Page) => window.locator('.status-bar');

function makeProject(kind: 'article' | 'book'): { dir: string; projectJson: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), `cliodeck-e2e-focus-${kind}-`));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  const base = {
    id: kind === 'article' ? '00000000-0000-4000-8000-000000000071' : '00000000-0000-4000-8000-000000000072',
    name: `Projet ${kind}`,
    type: kind,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (kind === 'article') {
    const file = join(dir, 'document.md');
    writeFileSync(file, ARTICLE);
    writeFileSync(projectJson, JSON.stringify(base));
    return { dir, projectJson, file };
  }
  mkdirSync(join(dir, 'chapters'), { recursive: true });
  const file = join(dir, 'chapters', '01-un.md');
  writeFileSync(file, '# Un\n\nHuit mille mots déjà enregistrés.\n');
  writeFileSync(
    projectJson,
    JSON.stringify({
      ...base,
      chapters: [{ id: 'c1', title: 'Un', filePath: 'chapters/01-un.md', order: 0, kind: 'chapter' }],
    }),
  );
  return { dir, projectJson, file };
}

async function withProject(
  kind: 'article' | 'book',
  run: (app: ElectronApplication, window: Page, project: ReturnType<typeof makeProject>) => Promise<void>,
): Promise<void> {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const project = makeProject(kind);
  try {
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, project.projectJson);
    await window.locator('button[title="Ouvrir un projet"]').first().click();
    await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });
    await run(app, window, project);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(project.dir, { recursive: true, force: true });
  }
}

async function selectLastWord(window: Page): Promise<void> {
  await editor(window).locator('.cm-line', { hasText: LAST_WORD }).click();
  await window.keyboard.press('End');
  await window.keyboard.press('ArrowLeft');
  for (let i = 0; i < LAST_WORD.length; i += 1) await window.keyboard.press('Shift+ArrowLeft');
}

test('document tout juste ouvert : la barre d’état dit « Non modifié », et « Non enregistré » nulle part', async () => {
  await withProject('article', async (_app, window) => {
    await expect(status(window)).toContainText('Non modifié');
    await expect(status(window)).not.toContainText('Non enregistré');
  });
});

test('après un clic sur Enregistrer, Cmd+B met la sélection en gras, et une espace s’écrit dans le texte', async () => {
  await withProject('article', async (_app, window, project) => {
    await selectLastWord(window);
    await saveButton(window).click();
    await expect(editor(window)).toBeFocused();

    await window.keyboard.press('ControlOrMeta+B');
    await expect(editor(window)).toContainText(`**${LAST_WORD}**`);

    await window.keyboard.press('End');
    await window.keyboard.type(' Fin');
    // Les `**` se cachent quand le curseur s'éloigne : le disque fait foi.
    await expect
      .poll(() => readFileSync(project.file, 'utf8'), { timeout: 10_000 })
      .toBe(ARTICLE.replace(`${LAST_WORD}.`, `**${LAST_WORD}**. Fin`));
  });
});

test('le clavier atteint encore les boutons : Tab jusqu’à Enregistrer, Entrée écrit', async () => {
  await withProject('article', async (_app, window, project) => {
    await editor(window).locator('.cm-line', { hasText: LAST_WORD }).click();
    await window.keyboard.press('End');
    await window.keyboard.type(' Ajout.');
    await saveButton(window).focus();
    await expect(saveButton(window)).toBeFocused();
    await window.keyboard.press('Enter');
    await expect
      .poll(() => readFileSync(project.file, 'utf8'), { timeout: 5_000 })
      .toBe(ARTICLE.replace(`${LAST_WORD}.`, `${LAST_WORD}. Ajout.`));
  });
});

test('livre : un renommage de chapitre en cours ne se perd pas sous un clic sur la barre, et se termine à Entrée', async () => {
  await withProject('book', async (_app, window, project) => {
    await window.locator('.chapter-navigator').getByText('Un', { exact: true }).dblclick();
    const rename = window.locator('.chapter-title-input');
    await expect(rename).toBeFocused();
    await rename.fill('Premier chapitre');

    await saveButton(window).click();
    // Le clic ne prend pas le focus : la saisie reste ouverte, avec ce qui a été tapé.
    await expect(rename).toBeFocused();
    await expect(rename).toHaveValue('Premier chapitre');

    await window.keyboard.press('Enter');
    await expect(rename).toHaveCount(0);
    await expect(window.locator('.chapter-navigator')).toContainText('Premier chapitre');
    await expect
      .poll(() => JSON.parse(readFileSync(project.projectJson, 'utf8')).chapters[0].title, { timeout: 10_000 })
      .toBe('Premier chapitre');
  });
});
