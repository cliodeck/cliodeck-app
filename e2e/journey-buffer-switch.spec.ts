/**
 * Changer de document ne perd rien, et « Nouveau fichier » n'écrase rien.
 *
 * Tous les chemins qui remplacent le document passent par une seule porte
 * (`editorStore.replaceBuffer`) : ce parcours la vérifie là où Vitest ne voit rien,
 * avec la vraie vue, le vrai autosave, le vrai dialogue et **le fichier** sur le disque.
 *
 * Les accélérateurs natifs ne passent pas par Playwright : le menu est simulé par
 * `webContents.send`, ce que fait le main à la réception du raccourci.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';

const CHAPTER_ONE = '# Chapitre un\n\nTexte du premier chapitre.\n';
const CHAPTER_TWO = '# Chapitre deux\n\nTexte du second chapitre.\n';
const ARTICLE = '# Article\n\nHuit mille mots déjà enregistrés.\n';

interface ProjectOnDisk {
  dir: string;
  projectJson: string;
}

function baseProject(type: 'article' | 'book', extra: Record<string, unknown> = {}): ProjectOnDisk {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-bascule-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000011',
      name: 'Projet E2E',
      type,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...extra,
    }),
  );
  return { dir, projectJson };
}

function makeBook(): ProjectOnDisk & { one: string; two: string } {
  const project = baseProject('book', {
    chapters: [
      { id: 'c1', title: 'Un', filePath: 'chapters/01-un.md', order: 0, kind: 'chapter' },
      { id: 'c2', title: 'Deux', filePath: 'chapters/02-deux.md', order: 1, kind: 'chapter' },
    ],
  });
  mkdirSync(join(project.dir, 'chapters'));
  const one = join(project.dir, 'chapters', '01-un.md');
  const two = join(project.dir, 'chapters', '02-deux.md');
  writeFileSync(one, CHAPTER_ONE);
  writeFileSync(two, CHAPTER_TWO);
  return { ...project, one, two };
}

function makeArticle(extra: Record<string, unknown> = {}): ProjectOnDisk & { document: string } {
  const project = baseProject('article', extra);
  const document = join(project.dir, 'document.md');
  writeFileSync(document, ARTICLE);
  return { ...project, document };
}

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
}

/** Ce qu'observe le dialogue natif simulé : la forme vit dans le processus main. */
interface SaveDialogOptions {
  defaultPath?: string;
  properties?: string[];
}

const editor = (window: Page) => window.locator('.codemirror-editor .cm-content');
const chapterButton = (window: Page, title: string) =>
  window.locator('button.chapter-item-open', { hasText: title }).first();

async function typeAtEnd(window: Page, text: string): Promise<void> {
  await editor(window).click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type(text);
}

const sendMenu = (app: ElectronApplication, channel: string) =>
  app.evaluate(({ BrowserWindow }, c) => {
    BrowserWindow.getAllWindows()[0].webContents.send(c);
  }, channel);

const answerConfirm = (window: Page, answer: 'confirm' | 'cancel') =>
  window.locator(`.confirm-dialog .confirm-dialog-btn-${answer}`).click();

test('livre : la bascule immédiate écrit chaque chapitre chez lui, et le retour garde l’annulation', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const book = makeBook();

  try {
    await openProject(app, window, book.projectJson);
    await expect(editor(window)).toContainText('Texte du premier chapitre', { timeout: 20_000 });

    // Frappe puis clic immédiat, bien avant les 3 s de l'autosave et les 300 ms de la synchro.
    await typeAtEnd(window, 'Frappe dans un.');
    await chapterButton(window, 'Deux').click();
    await expect(editor(window)).toContainText('Texte du second chapitre');

    expect(readFileSync(book.one, 'utf8')).toBe(`${CHAPTER_ONE}Frappe dans un.`);
    expect(readFileSync(book.two, 'utf8')).toBe(CHAPTER_TWO);

    // Le chapitre entrant reçoit l'autosave, et rien d'autre que sa frappe.
    await typeAtEnd(window, 'Frappe dans deux.');
    await expect
      .poll(() => readFileSync(book.two, 'utf8'), { timeout: 8_000 })
      .toBe(`${CHAPTER_TWO}Frappe dans deux.`);
    expect(readFileSync(book.one, 'utf8')).toBe(`${CHAPTER_ONE}Frappe dans un.`);

    await chapterButton(window, 'Un').click();
    await expect(editor(window)).toContainText('Frappe dans un.');

    await editor(window).click();
    await window.keyboard.press('ControlOrMeta+z');
    await expect(editor(window)).not.toContainText('Frappe dans un.');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(book.dir, { recursive: true, force: true });
  }
});

test('livre : cliquer le chapitre ouvert ne perd ni le texte ni l’annulation', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const book = makeBook();

  try {
    await openProject(app, window, book.projectJson);
    await expect(editor(window)).toContainText('Texte du premier chapitre', { timeout: 20_000 });

    await typeAtEnd(window, 'Une phrase tapée.');
    // Après la synchro différée (300 ms), avant l'autosave (3 s) : la fenêtre de la perte.
    await window.waitForTimeout(800);
    await chapterButton(window, 'Un').click();
    await window.waitForTimeout(300);

    await expect(editor(window)).toContainText('Une phrase tapée.');
    await editor(window).click();
    await window.keyboard.press('ControlOrMeta+z');
    await expect(editor(window)).not.toContainText('Une phrase tapée.');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(book.dir, { recursive: true, force: true });
  }
});

test('livre : le menu Nouveau fichier ajoute un chapitre, sans quitter celui qui est ouvert', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const book = makeBook();

  try {
    await openProject(app, window, book.projectJson);
    await expect(editor(window)).toContainText('Texte du premier chapitre', { timeout: 20_000 });
    await expect(window.locator('button.chapter-item-open')).toHaveCount(2);

    await sendMenu(app, 'menu:new-file');

    await expect(window.locator('button.chapter-item-open')).toHaveCount(3);
    await expect(editor(window)).toContainText('Texte du premier chapitre');
    await expect(window.locator('li.chapter-item.active')).toHaveCount(1);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(book.dir, { recursive: true, force: true });
  }
});

test('article : Nouveau fichier laisse document.md intact, et il se rouvre avec sa frappe', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const article = makeArticle();

  try {
    await openProject(app, window, article.projectJson);
    await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });

    await typeAtEnd(window, 'Dernière phrase.');
    await window.locator('.toolbar-btn[title="Nouveau fichier"]').first().click();
    await answerConfirm(window, 'confirm');

    await expect(editor(window)).not.toContainText('Huit mille mots');
    await window.waitForTimeout(4_000);
    expect(readFileSync(article.document, 'utf8')).toBe(`${ARTICLE}Dernière phrase.`);

    // La frappe suivante n'a nulle part où partir : l'autosave n'y touche pas.
    await typeAtEnd(window, 'Une idée neuve.');
    await window.waitForTimeout(4_000);
    expect(readFileSync(article.document, 'utf8')).toBe(`${ARTICLE}Dernière phrase.`);
    await expect(window.locator('.status-bar')).toContainText('Modifications non enregistrées');

    // Le fichier reste accessible depuis le panneau Projet.
    await window.locator('.project-file-item', { hasText: 'document.md' }).click();
    await expect(window.locator('.confirm-dialog')).toContainText('sans titre');
    await answerConfirm(window, 'confirm');
    await expect(editor(window)).toContainText('Dernière phrase.');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(article.dir, { recursive: true, force: true });
  }
});

test('article : Cmd+S après Nouveau fichier ne propose pas de remplacer document.md', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const article = makeArticle();
  const chosen = join(article.dir, 'une-idee.md');

  try {
    await openProject(app, window, article.projectJson);
    await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });

    await window.locator('.toolbar-btn[title="Nouveau fichier"]').first().click();
    await answerConfirm(window, 'confirm');
    await expect(editor(window)).not.toContainText('Huit mille mots');
    await typeAtEnd(window, 'Une idée à part.');

    // L'auteur valide le nom proposé, s'il y en a un. Le dialogue natif est simulé :
    // l'invite « Remplacer ? » du système, seul rempart jusqu'ici, n'est pas exercée.
    await app.evaluate(({ dialog }, fallback) => {
      const seen: SaveDialogOptions[] = [];
      (globalThis as unknown as { saveDialogOptions: SaveDialogOptions[] }).saveDialogOptions = seen;
      (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async (options: SaveDialogOptions) => {
        seen.push(options);
        const proposed = options.defaultPath ?? '';
        return { canceled: false, filePath: proposed.endsWith('.md') ? proposed : fallback };
      };
    }, chosen);
    await sendMenu(app, 'menu:save-file');

    await expect
      .poll(() => (existsSync(chosen) ? readFileSync(chosen, 'utf8') : null), { timeout: 5_000 })
      .toBe('Une idée à part.');
    expect(readFileSync(article.document, 'utf8')).toBe(ARTICLE);

    const [options] = await app.evaluate(
      () => (globalThis as unknown as { saveDialogOptions: SaveDialogOptions[] }).saveDialogOptions,
    );
    // Le dossier du dernier choix est conservé (Electron 43), sans nom de fichier.
    expect(options.defaultPath ?? '').not.toContain('document.md');
    expect(options.properties).toContain('showOverwriteConfirmation');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(article.dir, { recursive: true, force: true });
  }
});

test('article : le menu Nouveau fichier pose la même question que le bouton', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const article = makeArticle();

  try {
    await openProject(app, window, article.projectJson);
    await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });

    await typeAtEnd(window, 'Dernière phrase.');
    await sendMenu(app, 'menu:new-file');
    await answerConfirm(window, 'cancel');
    await expect(editor(window)).toContainText('Dernière phrase.');

    await sendMenu(app, 'menu:new-file');
    await answerConfirm(window, 'confirm');
    await expect(editor(window)).not.toContainText('Huit mille mots');
    expect(readFileSync(article.document, 'utf8')).toBe(`${ARTICLE}Dernière phrase.`);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(article.dir, { recursive: true, force: true });
  }
});

test('deux projets : frappe pendant une écriture lente, puis ouverture de B : le document de B reste', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const a = makeArticle();
  const b = makeArticle({ id: '00000000-0000-4000-8000-000000000022', name: 'Projet B' });

  try {
    await openProject(app, window, a.projectJson);
    await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });

    // Un disque lent (clé USB, dossier réseau) : 900 ms par écriture.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
      })._invokeHandlers;
      const original = handlers.get('editor:save-file');
      if (!original) throw new Error('editor:save-file introuvable');
      handlers.set('editor:save-file', async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return original(...args);
      });
    });

    await typeAtEnd(window, 'Phrase un.');
    await sendMenu(app, 'menu:save-file');
    await window.waitForTimeout(100);
    // Pendant l'écriture : la réponse efface `isDirty`, le texte vivant reste en avance.
    await window.keyboard.type(' Phrase deux.');
    await expect
      .poll(() => readFileSync(a.document, 'utf8'), { timeout: 5_000 })
      .toBe(`${ARTICLE}Phrase un.`);
    await window.waitForTimeout(600);

    await openProject(app, window, b.projectJson);
    await expect
      .poll(() => readFileSync(a.document, 'utf8'), { timeout: 5_000 })
      .toBe(`${ARTICLE}Phrase un. Phrase deux.`);
    await expect(editor(window)).not.toContainText('Phrase un.', { timeout: 10_000 });
    await expect(editor(window)).toContainText('Huit mille mots');
    expect(readFileSync(b.document, 'utf8')).toBe(ARTICLE);
    await window.waitForTimeout(3_500);
    expect(readFileSync(a.document, 'utf8')).toBe(`${ARTICLE}Phrase un. Phrase deux.`);
    expect(readFileSync(b.document, 'utf8')).toBe(ARTICLE);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});
