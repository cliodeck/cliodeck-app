/**
 * Créer un projet ouvre son document, et ouvrir un projet coupe l'éditeur de l'ancien.
 *
 * `createProject` n'ouvrait rien : après « Créer », l'éditeur restait sur un tampon sans
 * chemin (chaque démarrage) ou sur le fichier du projet précédent, que le main refusait
 * d'écrire. Une session entière se perdait sans un mot. Et une frappe pendant
 * `project:load` faisait réécrire le document du projet entrant par « # Nom ».
 *
 * Vraie modale, vrai autosave, vrai validateur de chemins : l'assertion porte sur le
 * fichier du disque.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';

const A_TEXT = '# Article A\n\nHuit mille mots déjà enregistrés.\n';
const B_TEXT = '# Article B\n\nDouze mille mots déjà enregistrés.\n';

const editor = (window: Page) => window.locator('.codemirror-editor .cm-content');

function makeArticle(name: string, id: string, text: string): { dir: string; projectJson: string; document: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-projet-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({ id, name, type: 'article', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
  );
  const document = join(dir, 'document.md');
  writeFileSync(document, text);
  return { dir, projectJson, document };
}

const makeA = () => makeArticle('Projet A', '00000000-0000-4000-8000-000000000011', A_TEXT);
const makeB = () => makeArticle('Projet B', '00000000-0000-4000-8000-000000000022', B_TEXT);

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
}

/** Dialogue de dossier simulé, vraie modale, accompagnement fermé. */
async function createProject(
  app: ElectronApplication,
  window: Page,
  parent: string,
  name: string,
  type: 'article' | 'book' | 'presentation',
): Promise<void> {
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, parent);
  await window.locator('button[title="Nouveau projet"]').first().click();
  await window.locator('.create-project-content select').selectOption(type);
  await window.locator('.create-project-content input[type="text"]').first().fill(name);
  await window.locator('.create-project-content .path-selector button').click();
  await expect(window.locator('.create-project-content .path-selector input')).toHaveValue(parent);
  await window.locator('.create-project-content .btn-submit').click();
  await expect(window.locator('.create-project-content')).toHaveCount(0, { timeout: 20_000 });
  await window.locator('.onboarding-wizard__close').click();
  await expect(window.locator('.onboarding-wizard')).toHaveCount(0);
}

async function typeAtEnd(window: Page, text: string): Promise<void> {
  await editor(window).click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type(text);
}

/** `project:load` lent : ce que coûte une attente d'indexation ou un gros corpus. */
async function slowDownProjectLoad(app: ElectronApplication, ms: number): Promise<void> {
  await app.evaluate(({ ipcMain }, delay) => {
    const handlers = (ipcMain as unknown as {
      _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
    })._invokeHandlers;
    const original = handlers.get('project:load');
    if (!original) throw new Error('project:load introuvable');
    handlers.set('project:load', async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return original(...args);
    });
  }, ms);
}

/** `project:load` échoue : sans que le main ait basculé, ou après, à l'initialisation des services. */
async function failProjectLoad(app: ElectronApplication, moment: 'avant' | 'après'): Promise<void> {
  await app.evaluate(({ ipcMain }, when) => {
    const handlers = (ipcMain as unknown as {
      _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
    })._invokeHandlers;
    const original = handlers.get('project:load');
    if (!original) throw new Error('project:load introuvable');
    handlers.set('project:load', async (...args: unknown[]) => {
      if (when === 'après') await original(...args);
      return { success: false, error: 'services' };
    });
  }, moment);
}

test('aucun projet ouvert : le texte tapé après « Créer » s’écrit dans le document du projet', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const parent = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-creation-'));
  const document = join(parent, 'These', 'document.md');

  try {
    await createProject(app, window, parent, 'These', 'article');
    await expect(editor(window)).toContainText('These');

    await typeAtEnd(window, ' Une session entière.');
    await window.waitForTimeout(3_500);

    expect(readFileSync(document, 'utf8')).toBe('# These Une session entière.');
  } finally {
    await app.close().catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('projet A ouvert : la création passe sur le nouveau document, et A garde sa dernière frappe', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const a = makeA();
  const parent = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-creation-'));
  const document = join(parent, 'Neuf', 'document.md');

  try {
    await openProject(app, window, a.projectJson);
    await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });
    await typeAtEnd(window, 'Dernier mot.');

    await createProject(app, window, parent, 'Neuf', 'article');
    await expect(editor(window)).toContainText('Neuf');
    await expect(editor(window)).not.toContainText('Huit mille mots');
    expect(readFileSync(a.document, 'utf8')).toBe(`${A_TEXT}Dernier mot.`);

    await typeAtEnd(window, ' Première phrase.');
    await window.waitForTimeout(3_500);

    expect(readFileSync(document, 'utf8')).toBe('# Neuf Première phrase.');
    expect(readFileSync(a.document, 'utf8')).toBe(`${A_TEXT}Dernier mot.`);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('depuis un article : un livre ouvre son premier chapitre, une présentation slides.md', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const a = makeA();
  const parent = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-creation-'));

  try {
    await openProject(app, window, a.projectJson);
    await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });

    await createProject(app, window, parent, 'Ouvrage', 'book');
    await expect(editor(window)).toContainText('Introduction');
    await expect(window.locator('button.chapter-item-open', { hasText: 'Introduction' })).toHaveCount(1);
    await typeAtEnd(window, 'Un paragraphe.');
    const chapter = join(parent, 'Ouvrage', 'chapters', '01-introduction.md');
    await expect
      .poll(() => readFileSync(chapter, 'utf8'), { timeout: 8_000 })
      .toBe('# Introduction\n\nUn paragraphe.');

    await createProject(app, window, parent, 'Cours', 'presentation');
    await expect(editor(window)).not.toContainText('Un paragraphe.');
    await typeAtEnd(window, 'Une diapositive.');
    const slides = join(parent, 'Cours', 'slides.md');
    await expect.poll(() => readFileSync(slides, 'utf8'), { timeout: 8_000 }).toContain('Une diapositive.');
    expect(readFileSync(chapter, 'utf8')).toBe('# Introduction\n\nUn paragraphe.');
    expect(readFileSync(a.document, 'utf8')).toBe(A_TEXT);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

// Au début du chargement, puis dans ses 300 dernières ms : la synchro n'a pas à être passée.
for (const [moment, afterClick] of [
  ['au début de', 100],
  ['à la fin de', 650],
] as const) {
  test(`frappe ${moment} project:load : le document de B n’est pas réécrit`, async () => {
    const outcome = await launchApp();
    if (outcome.kind === 'skip') {
      test.skip(true, outcome.reason);
      return;
    }
    const { app, window, userDataDir } = outcome.value;
    const a = makeA();
    const b = makeB();

    try {
      await openProject(app, window, a.projectJson);
      await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });
      await slowDownProjectLoad(app, 800);
      await typeAtEnd(window, 'Avant.');
      await window.waitForTimeout(500);

      await openProject(app, window, b.projectJson);
      await window.waitForTimeout(afterClick);
      await editor(window).click({ force: true });
      await window.keyboard.type('x');

      await expect(editor(window)).toContainText('Douze mille mots', { timeout: 10_000 });
      await window.waitForTimeout(3_500);
      expect(readFileSync(b.document, 'utf8')).toBe(B_TEXT);
      expect(readFileSync(a.document, 'utf8')).toBe(`${A_TEXT}Avant.`);
      await expect(editor(window)).toHaveAttribute('contenteditable', 'true');
    } finally {
      await app.close().catch(() => undefined);
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}

test('pendant un project:load long, l’éditeur le dit, et Cmd+S comme Nouveau fichier ne créent rien', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const a = makeA();
  const b = makeB();
  const strayDir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-egare-'));
  const stray = join(strayDir, 'vide.md');
  writeFileSync(stray, 'Ne pas écraser.\n');

  try {
    await openProject(app, window, a.projectJson);
    await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });
    await slowDownProjectLoad(app, 3_000);
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, stray);

    await openProject(app, window, b.projectJson);
    await expect(editor(window)).toContainText('Ouverture du projet');
    await expect(editor(window)).toHaveAttribute('contenteditable', 'false');

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:save-file');
    });
    await window.locator('.toolbar-btn[title="Enregistrer"]').first().click();
    await window.locator('.toolbar-btn[title="Nouveau fichier"]').first().click();
    await window.waitForTimeout(300);
    await expect(window.locator('.confirm-dialog')).toHaveCount(0);

    await expect(editor(window)).toContainText('Douze mille mots', { timeout: 10_000 });
    await expect(editor(window)).toHaveAttribute('contenteditable', 'true');
    expect(readFileSync(stray, 'utf8')).toBe('Ne pas écraser.\n');
    expect(readFileSync(b.document, 'utf8')).toBe(B_TEXT);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
    rmSync(strayDir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('project.json illisible : A ne bouge pas, sa proposition en attente reste, et sa frappe s’écrit toujours', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const a = makeA();
  const b = makeB();
  writeFileSync(b.projectJson, '{ pas du JSON');

  try {
    await openProject(app, window, a.projectJson);
    await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });
    await typeAtEnd(window, 'Avant.');
    await window.evaluate(() => {
      (window as unknown as {
        __cliodeckProposals: { inject: (p: Record<string, unknown>) => unknown };
      }).__cliodeckProposals.inject({
        range: { from: 0, to: 0 },
        original: '',
        proposed: 'Proposition du modèle.',
        category: 'ai-insert',
        source: { model: 'm', task: 't' },
      });
    });
    await expect(window.locator('.cm-proposal-box')).toHaveCount(1);

    await openProject(app, window, b.projectJson);
    await expect(window.locator('#alert-dialog-message')).toBeVisible({ timeout: 15_000 });
    await window.locator('.alert-dialog-btn-ok').click();

    await expect(window.locator('.cm-proposal-box')).toHaveCount(1);
    await expect(editor(window)).toContainText('Avant.');
    await typeAtEnd(window, ' Après.');
    await expect.poll(() => readFileSync(a.document, 'utf8'), { timeout: 8_000 }).toBe(`${A_TEXT}Avant. Après.`);
    expect(readFileSync(b.document, 'utf8')).toBe(B_TEXT);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('le main refuse B sans avoir basculé : A revient avec son texte et son annulation', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const a = makeA();
  const b = makeB();

  try {
    await openProject(app, window, a.projectJson);
    await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });
    await typeAtEnd(window, 'Avant.');

    await failProjectLoad(app, 'avant');
    await openProject(app, window, b.projectJson);
    await expect(window.locator('#alert-dialog-message')).toBeVisible({ timeout: 15_000 });
    await window.locator('.alert-dialog-btn-ok').click();

    await expect(editor(window)).toContainText('Avant.');
    expect(readFileSync(a.document, 'utf8')).toBe(`${A_TEXT}Avant.`);
    await editor(window).click();
    await window.keyboard.press('ControlOrMeta+z');
    await expect(editor(window)).not.toContainText('Avant.');
    await typeAtEnd(window, 'Après.');
    await expect.poll(() => readFileSync(a.document, 'utf8'), { timeout: 8_000 }).toBe(`${A_TEXT}Après.`);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('livre, échec après le passage du main : renommer le chapitre d’avant ne touche pas au tampon', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-projet-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  mkdirSync(join(dir, 'chapters'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  const chapterTwo = join(dir, 'chapters', '02-deux.md');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000044',
      name: 'Livre A',
      type: 'book',
      chapters: [
        { id: 'c1', title: 'Un', filePath: 'chapters/01-un.md', order: 0, kind: 'chapter' },
        { id: 'c2', title: 'Deux', filePath: 'chapters/02-deux.md', order: 1, kind: 'chapter' },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'chapters', '01-un.md'), '# Un\n\nChapitre un.\n');
  writeFileSync(chapterTwo, '# Deux\n\nChapitre deux.\n');
  const b = makeB();

  try {
    await openProject(app, window, projectJson);
    await expect(editor(window)).toContainText('Chapitre un', { timeout: 20_000 });
    const chapter = window.locator('.chapter-item-open', { hasText: 'Deux' });
    await chapter.click();
    await expect(editor(window)).toContainText('Chapitre deux');

    await failProjectLoad(app, 'après');
    await openProject(app, window, b.projectJson);
    await expect(window.locator('#alert-dialog-message')).toBeVisible({ timeout: 15_000 });
    await window.locator('.alert-dialog-btn-ok').click();
    await expect(editor(window)).not.toContainText('Chapitre deux');

    // Le premier clic du double clic tente d'ouvrir le chapitre, que le main refuse :
    // la saisie s'ouvre derrière l'alerte, et perd le focus en la fermant.
    await chapter.dblclick();
    await expect(window.locator('#alert-dialog-message')).toBeVisible({ timeout: 10_000 });
    await window.locator('.alert-dialog-btn-ok').click();
    await expect(window.locator('.chapter-title-input')).toHaveCount(0);
    await window.waitForTimeout(500);

    await expect(editor(window)).not.toContainText('Deux');
    expect(readFileSync(chapterTwo, 'utf8')).toBe('# Deux\n\nChapitre deux.\n');
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('tampon sans titre : Annuler garde le texte et le projet, et rien n’est ouvert', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const a = makeA();
  const b = makeB();

  try {
    await openProject(app, window, a.projectJson);
    await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });
    await window.locator('.toolbar-btn[title="Nouveau fichier"]').first().click();
    await window.locator('.confirm-dialog .confirm-dialog-btn-confirm').click();
    await expect(editor(window)).not.toContainText('Huit mille mots');
    await typeAtEnd(window, 'Idée sans titre');

    await openProject(app, window, b.projectJson);
    await expect(window.locator('.confirm-dialog')).toContainText('sans titre', { timeout: 10_000 });
    await window.locator('.confirm-dialog .confirm-dialog-btn-cancel').click();

    await expect(editor(window)).toContainText('Idée sans titre');
    await expect(window.locator('.project-loading-overlay')).toHaveCount(0);
    // Toujours le projet A : son document se rouvre sans refus du main.
    await window.locator('.project-file-item', { hasText: 'document.md' }).click();
    await expect(window.locator('.confirm-dialog')).toContainText('sans titre');
    await window.locator('.confirm-dialog .confirm-dialog-btn-confirm').click();
    await expect(editor(window)).toContainText('Huit mille mots');
    expect(readFileSync(b.document, 'utf8')).toBe(B_TEXT);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('tampon sans titre : accord, puis nom de projet déjà pris : le texte revient', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const parent = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-creation-'));
  mkdirSync(join(parent, 'Pris'), { recursive: true });
  const taken = JSON.stringify({ id: 'pris', name: 'Pris', type: 'article', createdAt: new Date().toISOString() });
  writeFileSync(join(parent, 'Pris', 'project.json'), taken);

  try {
    await typeAtEnd(window, 'Idée sans titre');
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, parent);
    await window.locator('button[title="Nouveau projet"]').first().click();
    await window.locator('.create-project-content input[type="text"]').first().fill('Pris');
    await window.locator('.create-project-content .path-selector button').click();
    await expect(window.locator('.create-project-content .path-selector input')).toHaveValue(parent);
    await window.locator('.create-project-content .btn-submit').click();
    await expect(window.locator('.confirm-dialog')).toContainText('sans titre', { timeout: 5_000 });
    await window.locator('.confirm-dialog .confirm-dialog-btn-confirm').click();

    await expect(window.locator('#alert-dialog-message')).toContainText("Rien n'a été modifié", { timeout: 10_000 });
    await window.locator('.alert-dialog-btn-ok').click();

    await expect(editor(window)).toContainText('Idée sans titre');
    await expect(editor(window)).toHaveAttribute('contenteditable', 'true');
    expect(readFileSync(join(parent, 'Pris', 'project.json'), 'utf8')).toBe(taken);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('pendant un project:load long, le navigateur n’ajoute aucun chapitre au livre qu’on quitte', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-projet-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  mkdirSync(join(dir, 'chapters'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  const chapters = [{ id: 'c1', title: 'Un', filePath: 'chapters/01-un.md', order: 0, kind: 'chapter' }];
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000033',
      name: 'Livre A',
      type: 'book',
      chapters,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'chapters', '01-un.md'), '# Un\n\nChapitre un.\n');
  const b = makeB();

  try {
    await openProject(app, window, projectJson);
    await expect(editor(window)).toContainText('Chapitre un', { timeout: 20_000 });
    const addChapter = window.locator('.chapter-navigator-action[title="Ajouter un chapitre"]');
    await expect(addChapter).toBeEnabled();

    await slowDownProjectLoad(app, 1_500);
    await openProject(app, window, b.projectJson);
    await expect(editor(window)).toContainText('Ouverture du projet');
    await expect(addChapter).toBeDisabled();

    await expect(editor(window)).toContainText('Douze mille mots', { timeout: 20_000 });
    const manifest = JSON.parse(readFileSync(projectJson, 'utf8')) as { chapters: unknown[] };
    expect(manifest.chapters).toHaveLength(1);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

for (const choice of ['le même projet', 'un autre projet']) {
  test(`dialogue d’ouverture resté ouvert : choisir ${choice} pendant une ouverture ne vide pas l’éditeur`, async () => {
    const outcome = await launchApp();
    if (outcome.kind === 'skip') {
      test.skip(true, outcome.reason);
      return;
    }
    const { app, window, userDataDir } = outcome.value;
    const a = makeA();
    const b = makeB();
    const c = makeArticle('Projet C', '00000000-0000-4000-8000-000000000044', '# Article C\n\nTrois mille mots.\n');
    const fromDialog = choice === 'le même projet' ? b : c;

    try {
      await openProject(app, window, b.projectJson);
      await expect(editor(window)).toContainText('Douze mille mots', { timeout: 20_000 });
      await openProject(app, window, a.projectJson);
      await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });
      await window.getByText('Projets récents').click();
      const recentB = window.locator('.recent-project-content', { hasText: 'Projet B' });
      await expect(recentB).toBeVisible();

      await slowDownProjectLoad(app, 700);
      // Sans fenêtre parente, le dialogue laisse la fenêtre cliquable : il répond plus tard.
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showOpenDialog = async () => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return { canceled: false, filePaths: [filePath] };
        };
      }, fromDialog.projectJson);
      await window.locator('button[title="Ouvrir un projet"]').first().click();
      await window.waitForTimeout(100);
      await recentB.click();

      await expect(editor(window)).toContainText('Douze mille mots', { timeout: 20_000 });
      await window.waitForTimeout(1_500);
      await expect(window.locator('.project-loading-overlay')).toHaveCount(0);
      await expect(editor(window)).toContainText('Douze mille mots');

      await typeAtEnd(window, 'Une session entière.');
      await window.waitForTimeout(3_500);
      expect(readFileSync(b.document, 'utf8')).toBe(`${B_TEXT}Une session entière.`);
      expect(readFileSync(c.document, 'utf8')).toBe('# Article C\n\nTrois mille mots.\n');
    } finally {
      await app.close().catch(() => undefined);
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
      rmSync(c.dir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}
