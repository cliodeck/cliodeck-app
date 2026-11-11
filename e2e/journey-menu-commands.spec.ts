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
  // Rangé hors du projet, comme un fichier téléchargé : le dialogue l'autorise (S07-1-3).
  const downloads = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-telechargements-'));
  try {
    await withArticle(async (app, window, article) => {
      const bib = join(downloads, 'source.bib');
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
      // Entré dans le projet sous son nom, et retenu par project.json.
      expect(readFileSync(join(article.dir, 'source.bib'), 'utf8')).toBe(BIBTEX);
      expect(JSON.parse(readFileSync(article.projectJson, 'utf8')).bibliographySource).toEqual({
        type: 'file',
        filePath: 'source.bib',
      });

      // Une bibliographie existe : la commande ne la remplace pas sans demander.
      await sendMenu(app, 'menu:import-bibtex');
      await expect(window.locator('.modal-overlay .modal-question')).toBeVisible({ timeout: 10_000 });
      expect(await opened()).toBe(2);
      await expect(window.locator('.citation-card')).toHaveCount(1);
    });
  } finally {
    rmSync(downloads, { recursive: true, force: true });
  }
});

/**
 * « Fusionner » un `.bib` téléchargé, du même nom que celui du projet (S07-1-3). La fusion
 * n'existait que dans le panneau, la copie du fichier rangé hors du projet était refusée, et
 * l'alerte était anglaise ; un homonyme copié aurait écrasé le `.bib` du projet et effacé sa
 * collection Zotero. Le total annoncé doit être celui que la réouverture relit.
 */
test('Bibliographie › Importer BibTeX › Fusionner, un .bib téléchargé : le total annoncé est relu à la réouverture, et la collection Zotero reste', async () => {
  const downloads = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-telechargements-'));
  const article = makeArticle('Projet fusion');
  const source = { type: 'zotero', filePath: 'bibliography.bib', zoteroCollection: 'COLL1234' };
  const manifest = () => JSON.parse(readFileSync(article.projectJson, 'utf8')) as Record<string, unknown>;
  writeFileSync(article.projectJson, JSON.stringify({ ...manifest(), bibliographySource: source, zotero: { collectionKey: 'COLL1234' } }));
  const projectBib = join(article.dir, 'bibliography.bib');
  writeFileSync(
    projectBib,
    `${BIBTEX}\n@book{martin2015,\n  author = {Martin, Anne},\n  title = {Les dépôts d'archives},\n  year = {2015}\n}\n`,
  );
  const downloaded = join(downloads, 'bibliography.bib');
  writeFileSync(
    downloaded,
    `${BIBTEX}\n@article{leroy2018,\n  author = {Leroy, Paul},\n  title = {Lire les registres},\n  year = {2018}\n}\n`,
  );

  const openArticle = async (app: ElectronApplication, window: Page) => {
    await stubOpenDialog(app, article.projectJson);
    await window.locator('button[title="Ouvrir un projet"]').first().click();
    await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });
    await window.locator('#left-tab-bibliography').click();
  };

  let userDataDir: string | null = null;
  try {
    const first = await launchApp();
    if (first.kind === 'skip') {
      test.skip(true, first.reason);
      return;
    }
    userDataDir = first.value.userDataDir;
    let announced = '';
    try {
      const { app, window } = first.value;
      await openArticle(app, window);
      await expect(window.locator('.citation-card')).toHaveCount(2, { timeout: 10_000 });

      await stubOpenDialog(app, downloaded);
      await sendMenu(app, 'menu:import-bibtex');
      await window.locator('.import-option-btn.merge-btn').click();

      const summary = window.locator('.bib-import-summary-modal');
      await expect(summary).toBeVisible({ timeout: 10_000 });
      await expect(window.locator('#alert-dialog-message')).toHaveCount(0);
      announced = (await summary.locator('.stat-item', { hasText: 'Références au total' }).locator('.stat-value').textContent()) ?? '';
      expect(announced).toBe('3');
      await summary.locator('.close-button').click();
      await expect(window.locator('.citation-card')).toHaveCount(3);

      // La fusion est sur le disque, dans le fichier du projet ; le fichier téléchargé n'a pas bougé.
      const written = readFileSync(projectBib, 'utf8');
      for (const key of ['dupont2020', 'martin2015', 'leroy2018']) expect(written).toContain(`{${key},`);
      expect(manifest().bibliographySource).toEqual(source);
      expect(manifest().zotero).toEqual({ collectionKey: 'COLL1234' });
    } finally {
      await first.value.app.close();
    }

    // Fermer, rouvrir : le panneau relit le fichier du projet, et y trouve le total annoncé.
    const second = await launchApp({ userDataDir });
    if (second.kind === 'skip') {
      test.skip(true, second.reason);
      return;
    }
    try {
      await openArticle(second.value.app, second.value.window);
      await expect(second.value.window.locator('.citation-card')).toHaveCount(Number(announced), { timeout: 10_000 });
      expect(manifest().bibliographySource).toEqual(source);
    } finally {
      await second.value.app.close();
    }
  } finally {
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    rmSync(article.dir, { recursive: true, force: true });
    rmSync(downloads, { recursive: true, force: true });
  }
});

test('Bibliographie › Connecter Zotero : les Réglages', async () => {
  await withArticle(async (app, window) => {
    await sendMenu(app, 'menu:connect-zotero');

    await expect(window.locator('.settings-modal')).toBeVisible({ timeout: 10_000 });
  });
});

/**
 * Format › Bloc citation. Sous macOS, Cmd+Maj+Q est « Fermer la session » : le raccourci passe à
 * Cmd+Option+Q (D3). Aucune touche n'est envoyée au système : l'accélérateur se lit dans le menu
 * construit, et l'entrée se clique par le menu lui-même.
 */
test('Format › Bloc citation : Cmd+Option+Q sous macOS, et l’entrée du menu cite le paragraphe une fois', async () => {
  await withArticle(async (app, window, article) => {
    const accelerator = await app.evaluate(({ Menu }) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
        for (const item of items) {
          if (item.label === 'Bloc citation') return item;
          const inner = item.submenu ? find(item.submenu.items) : null;
          if (inner) return inner;
        }
        return null;
      };
      const item = find(Menu.getApplicationMenu()?.items ?? []);
      return { accelerator: item?.accelerator ?? null, platform: process.platform };
    });
    expect(accelerator.accelerator).toBe(
      accelerator.platform === 'darwin' ? 'CmdOrCtrl+Alt+Q' : 'CmdOrCtrl+Shift+Q',
    );

    await selectLastWord(window);
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
        for (const item of items) {
          if (item.label === 'Bloc citation') return item;
          const inner = item.submenu ? find(item.submenu.items) : null;
          if (inner) return inner;
        }
        return null;
      };
      const win = BrowserWindow.getAllWindows()[0];
      find(Menu.getApplicationMenu()?.items ?? [])?.click(undefined, win, win.webContents);
    });

    await expect
      .poll(onDisk(article), { timeout: 8_000 })
      .toBe(ARTICLE.replace('Huit mille', '> Huit mille'));
  });
});

/**
 * macOS : l'app survit à la fermeture de sa fenêtre, et la barre de menus reste (S11-1-16). Le menu
 * fermait ses clics sur la fenêtre du lancement : Fichier › Ouvrir projet levait « Object has been
 * destroyed » et ne faisait rien. La commande recrée la fenêtre, et son renderer la reçoit une fois
 * React monté, pas seulement le main qui l'envoie. Fenêtre fermée par `close()` (la croix, Cmd+W),
 * entrée cliquée par le menu lui-même : aucune touche n'est envoyée au système.
 */
test('macOS : fenêtre fermée, Fichier › Ouvrir projet la rouvre, et le projet s’ouvre dans la fenêtre recréée', async () => {
  test.skip(process.platform !== 'darwin', 'Hors de macOS, fermer la dernière fenêtre quitte l’app.');
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, userDataDir } = outcome.value;
  const article = makeArticle('Projet rouvert par le menu');
  const stderr: string[] = [];
  app.process().stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  try {
    const opened = await stubOpenDialog(app, article.projectJson);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].close();
    });
    await expect.poll(windowCount, { timeout: 15_000 }).toBe(0);

    const reopened = app.waitForEvent('window', { timeout: 15_000 });
    await app.evaluate(({ Menu }) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
        for (const item of items) {
          if (item.label === 'Ouvrir projet') return item;
          const inner = item.submenu ? find(item.submenu.items) : null;
          if (inner) return inner;
        }
        return null;
      };
      const item = find(Menu.getApplicationMenu()?.items ?? []);
      if (!item) throw new Error('Entrée de menu absente : Ouvrir projet');
      item.click();
    });
    const window = await reopened;

    await expect(window.locator('.status-bar')).toContainText('Projet rouvert par le menu', { timeout: 20_000 });
    await expect(editor(window)).toContainText('Huit mille mots');
    expect(await opened()).toBe(1);
    expect(await windowCount()).toBe(1);
    expect(stderr.join('')).not.toMatch(/Object has been destroyed|uncaughtException/);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(article.dir, { recursive: true, force: true });
  }
});
