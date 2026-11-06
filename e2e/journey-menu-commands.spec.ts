/**
 * Les commandes du menu natif : une commande, une exécution, un effet.
 *
 * Le pont du preload ne savait pas retirer un écouteur (`contextBridge` livre un nouveau
 * mandataire à chaque traversée) : chaque commande s'exécutait deux fois dès le lancement, une
 * fois de plus à chaque changement de langue. Deux notes de bas de page, un gras qui se défaisait
 * (S15-1-22). Nouveau projet, Ouvrir un projet, Importer BibTeX et Connecter Zotero émettaient des
 * événements que personne n'écoutait, et ne faisaient rien (S15-1-30).
 *
 * Seul ce parcours traverse le vrai `contextBridge`. Les accélérateurs natifs ne passent pas par
 * Playwright : le menu est simulé par `webContents.send`, ce que fait le main à la réception du
 * raccourci ; les dialogues natifs sont simulés dans le main.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';

const ARTICLE = '# Article\n\nHuit mille mots déjà enregistrés.\n';
const LAST_WORD = 'enregistrés';
const BIBTEX = `@book{dupont2020,
  author = {Dupont, Jean},
  title = {Une histoire des archives},
  year = {2020}
}
`;

interface Article {
  dir: string;
  projectJson: string;
  document: string;
}

function makeArticle(name = 'Projet E2E'): Article {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-menu-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000021',
      name,
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const document = join(dir, 'document.md');
  writeFileSync(document, ARTICLE);
  return { dir, projectJson, document };
}

const editor = (window: Page) => window.locator('.codemirror-editor .cm-content');
const onDisk = (article: Article) => () => readFileSync(article.document, 'utf8');

const sendMenu = (app: ElectronApplication, channel: string) =>
  app.evaluate(({ BrowserWindow }, c) => {
    BrowserWindow.getAllWindows()[0].webContents.send(c);
  }, channel);

/** Le sélecteur de fichier natif, simulé : il rend `filePath` et compte ses ouvertures. */
async function stubOpenDialog(app: ElectronApplication, filePath: string): Promise<() => Promise<number>> {
  await app.evaluate(({ dialog }, target) => {
    const counter = globalThis as unknown as { __openDialogs: number };
    counter.__openDialogs = 0;
    dialog.showOpenDialog = async () => {
      counter.__openDialogs += 1;
      return { canceled: false, filePaths: [target] };
    };
  }, filePath);
  return () => app.evaluate(() => (globalThis as unknown as { __openDialogs: number }).__openDialogs);
}

/** Le dernier mot de « …déjà enregistrés. », point exclu, sélectionné au clavier. */
async function selectLastWord(window: Page): Promise<void> {
  await editor(window).locator('.cm-line', { hasText: LAST_WORD }).click();
  await window.keyboard.press('End');
  await window.keyboard.press('ArrowLeft');
  for (let i = 0; i < LAST_WORD.length; i += 1) await window.keyboard.press('Shift+ArrowLeft');
}

async function withArticle(run: (app: ElectronApplication, window: Page, article: Article) => Promise<void>): Promise<void> {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const article = makeArticle();
  try {
    await stubOpenDialog(app, article.projectJson);
    await window.locator('button[title="Ouvrir un projet"]').first().click();
    await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });
    await run(app, window, article);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(article.dir, { recursive: true, force: true });
  }
}

test('Insertion › Note de bas de page : une seule note', async () => {
  await withArticle(async (app, window, article) => {
    await selectLastWord(window);
    await window.keyboard.press('End');
    await sendMenu(app, 'menu:insert-footnote');

    await expect.poll(onDisk(article), { timeout: 8_000 }).toContain('[^1]');
    const written = onDisk(article)();
    // L'appel et sa définition : deux occurrences, et pas de seconde note.
    expect(written.match(/\[\^\d+\]/g)).toEqual(['[^1]', '[^1]']);
  });
});

test('Format › Gras : la sélection passe en gras, une fois', async () => {
  await withArticle(async (app, window, article) => {
    await selectLastWord(window);
    await sendMenu(app, 'menu:format-bold');

    await expect
      .poll(onDisk(article), { timeout: 8_000 })
      .toBe(ARTICLE.replace(LAST_WORD, `**${LAST_WORD}**`));
  });
});

test('Insertion › Citation : une seule clé derrière le mot', async () => {
  await withArticle(async (app, window, article) => {
    await selectLastWord(window);
    await sendMenu(app, 'menu:insert-citation');

    await expect
      .poll(onDisk(article), { timeout: 8_000 })
      .toBe(ARTICLE.replace(LAST_WORD, `${LAST_WORD} [@clé_citation]`));
  });
});

test('après deux changements de langue, une commande s’exécute encore une fois', async () => {
  await withArticle(async (app, window, article) => {
    // Par les Réglages, comme l'auteur : chaque changement relançait l'abonnement aux commandes.
    await sendMenu(app, 'menu:open-settings');
    const settings = window.locator('.settings-modal');
    await expect(settings).toBeVisible({ timeout: 10_000 });
    await settings.getByRole('button', { name: 'Langue', exact: true }).click();
    const select = settings.locator('select.config-select').first();
    await select.selectOption('en');
    await expect(settings.getByRole('button', { name: 'Language', exact: true })).toBeVisible();
    await select.selectOption('fr');
    await expect(settings.getByRole('button', { name: 'Langue', exact: true })).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);

    await selectLastWord(window);
    await sendMenu(app, 'menu:insert-link');

    await expect
      .poll(onDisk(article), { timeout: 8_000 })
      .toBe(ARTICLE.replace(LAST_WORD, `[${LAST_WORD}](url)`));
  });
});

test('Fichier › Ouvrir un projet : le sélecteur s’ouvre une fois, et le projet s’ouvre', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const article = makeArticle('Projet par le menu');
  try {
    const opened = await stubOpenDialog(app, article.projectJson);
    await sendMenu(app, 'menu:open-project');

    await expect(window.locator('.status-bar')).toContainText('Projet par le menu', { timeout: 20_000 });
    await expect(editor(window)).toContainText('Huit mille mots');
    expect(await opened()).toBe(1);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(article.dir, { recursive: true, force: true });
  }
});

test('Fichier › Nouveau projet, depuis la Bibliographie : la modale de création, qui prend le focus', async () => {
  await withArticle(async (app, window) => {
    await window.locator('#left-tab-bibliography').click();
    await editor(window).click();
    await sendMenu(app, 'menu:new-project');

    await expect(window.locator('.create-project-modal')).toHaveCount(1);
    await expect(window.locator('#left-tab-projects')).toHaveAttribute('aria-selected', 'true');
    await expect(window.locator('.create-project-modal input[type="text"]').first()).toBeFocused();
  });
});

test('Bibliographie › Importer BibTeX : l’import, puis le choix remplacer / fusionner quand il y a déjà des références', async () => {
  await withArticle(async (app, window, article) => {
    const bib = join(article.dir, 'source.bib');
    writeFileSync(bib, BIBTEX);
    const opened = await stubOpenDialog(app, bib);

    await sendMenu(app, 'menu:import-bibtex');
    await expect(window.locator('#left-tab-bibliography')).toHaveAttribute('aria-selected', 'true');
    await expect(window.locator('.citation-card')).toHaveCount(1, { timeout: 10_000 });
    expect(await opened()).toBe(1);
    // Le bilan de l'import est une modale : sous elle, le menu ne change pas de panneau.
    await expect(window.locator('.bib-import-summary-modal')).toBeVisible({ timeout: 10_000 });
    await window.locator('.bib-import-summary-modal .close-button').click();
    await expect(window.locator('.bib-import-summary-modal')).toHaveCount(0);

    // Une bibliographie existe : la commande ne la remplace pas sans demander.
    await sendMenu(app, 'menu:import-bibtex');
    await expect(window.locator('.modal-overlay .modal-question')).toBeVisible({ timeout: 10_000 });
    expect(await opened()).toBe(2);
    await expect(window.locator('.citation-card')).toHaveCount(1);
  });
});

test('Bibliographie › Connecter Zotero : les Réglages', async () => {
  await withArticle(async (app, window) => {
    await sendMenu(app, 'menu:connect-zotero');

    await expect(window.locator('.settings-modal')).toBeVisible({ timeout: 10_000 });
  });
});
