/**
 * Fermer la fenêtre, recharger ou réessayer après un plantage écrit d'abord le document.
 *
 * Seul Cmd+Q passait par le filet de sortie. La croix, Cmd+W, Cmd+R et « Réessayer »
 * détruisaient l'éditeur avec ce que l'autosave n'avait pas encore écrit, et un tampon
 * sans titre partait sans un mot. Vitest ne reproduit ni la fenêtre ni contextBridge :
 * ces parcours regardent **le fichier**, avec la vraie fenêtre et le vrai renderer.
 *
 * Les accélérateurs natifs ne passent pas par Playwright : `BrowserWindow.close()` est ce
 * que font la croix et le rôle `close` (Cmd+W), `app.quit()` ce que fait le rôle `quit`
 * (Cmd+Q), et les entrées de rechargement se cliquent par leur id. Le dialogue natif est
 * simulé (`_helpers/launch.ts`) : il bloquerait le parcours.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerLeaveDialog, launchApp, leaveDialogs } from './_helpers/launch';

const ARTICLE = '# Article\n\nHuit mille mots déjà enregistrés.\n';
const PHRASE = 'Dernière phrase.';
const LOCALES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'locales');

interface ArticleOnDisk {
  dir: string;
  projectJson: string;
  document: string;
}

function makeArticle(name = 'Projet E2E', text = ARTICLE): ArticleOnDisk {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-fermeture-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: `00000000-0000-4000-8000-${name === 'Projet E2E' ? '000000000051' : '000000000052'}`,
      name,
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const document = join(dir, 'document.md');
  writeFileSync(document, text);
  return { dir, projectJson, document };
}

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
}

const editor = (window: Page) => window.locator('.codemirror-editor .cm-content');

async function typeAtEnd(window: Page, text: string): Promise<void> {
  await editor(window).click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type(text);
}

const sendMenu = (app: ElectronApplication, channel: string) =>
  app.evaluate(({ BrowserWindow }, c) => {
    BrowserWindow.getAllWindows()[0].webContents.send(c);
  }, channel);

/** La croix et Cmd+W. */
const closeWindow = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
  });

/** Cmd+Q. */
const quit = (app: ElectronApplication) =>
  app.evaluate(({ app: electronApp }) => {
    electronApp.quit();
  });

/** Sous Windows et Linux, la dernière fenêtre fermée emporte l'app : plus rien à interroger. */
const windowCount = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length).catch(() => 0);

const dialogCount = async (app: ElectronApplication) => (await leaveDialogs(app)).length;

const clickMenuItem = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`Entrée de menu absente : ${itemId}`);
    item.click();
  }, id);

/** Un rechargement efface ce que la page a posé sur `window`. */
const markPage = (window: Page) =>
  window.evaluate(() => {
    (window as unknown as { __marked?: boolean }).__marked = true;
  });

const pageWasReloaded = (window: Page) =>
  window.evaluate(() => (window as unknown as { __marked?: boolean }).__marked !== true).catch(() => false);

/**
 * Un vrai plantage de rendu, sous la frontière d'erreur : un `setState` dont le calcul
 * lève. Rien n'est simulé après lui : React démonte l'arbre, la vue CodeMirror est détruite.
 */
async function crashRender(window: Page, selector = '.editor-panel'): Promise<void> {
  const crashed = await window.evaluate((target) => {
    const node = document.querySelector(target);
    if (!node) return false;
    type Hook = { queue?: { dispatch?: (update: () => never) => void }; next: Hook | null };
    type Fiber = { tag: number; memoizedState: unknown; return: Fiber | null };
    const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
    let fiber = key ? (node as unknown as Record<string, Fiber>)[key] : null;
    while (fiber) {
      if (fiber.tag === 0) {
        let hook = fiber.memoizedState as Hook | null;
        while (hook && typeof hook === 'object' && 'next' in hook) {
          if (typeof hook.queue?.dispatch === 'function') {
            hook.queue.dispatch(() => {
              throw new Error('Plantage de rendu provoqué par le test');
            });
            return true;
          }
          hook = hook.next;
        }
      }
      fiber = fiber.return;
    }
    return false;
  }, selector);
  expect(crashed).toBe(true);
  await expect(window.locator('.error-fallback')).toBeVisible({ timeout: 10_000 });
}

const retryButton = (window: Page) => window.locator('.error-fallback__retry');
const blockedMessage = (window: Page) => window.locator('.error-fallback__blocked');
const reloadAnywayButton = (window: Page) => window.locator('.error-fallback__reload-anyway');

/** Ferme les alertes en file : deux pour un envoi de menu, tant que ses écouteurs sont doublés (S15-1-22). */
async function dismissAlerts(window: Page): Promise<void> {
  const ok = window.locator('.alert-dialog-btn-ok');
  await expect(async () => {
    if (await ok.isVisible()) await ok.click();
    await expect(ok).toHaveCount(0, { timeout: 500 });
  }).toPass({ timeout: 10_000 });
}

/** Un tampon sans titre, hors du projet, avec du texte qui n'existe nulle part ailleurs. */
async function untitledBuffer(window: Page, text: string): Promise<void> {
  await window.locator('.toolbar-btn[title="Nouveau fichier"]').first().click();
  await window.locator('.confirm-dialog .confirm-dialog-btn-confirm').click();
  await expect(editor(window)).not.toContainText('Huit mille mots');
  if (text) await typeAtEnd(window, text);
}

/** Un parcours qui finit sur « Rester » bloquerait `app.close()`, et la suite avec lui. */
async function closeApp(app: ElectronApplication): Promise<void> {
  await answerLeaveDialog(app, 'leave').catch(() => undefined);
  await app.close().catch(() => undefined);
}

/** Ouvre un article et rend la main au parcours ; tout se défait ensuite, quoi qu'il arrive. */
async function withArticle(
  run: (app: ElectronApplication, window: Page, article: ArticleOnDisk) => Promise<void>,
): Promise<void> {
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
    await run(app, window, article);
  } finally {
    chmodSync(article.document, 0o644);
    await closeApp(app);
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(article.dir, { recursive: true, force: true });
  }
}

// MARK: - Le texte part avant la fenêtre

test('fermer la fenêtre juste après une frappe : la phrase est dans le fichier, sans question', async () => {
  await withArticle(async (app, window, article) => {
    await typeAtEnd(window, PHRASE);
    await closeWindow(app);

    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(0);
    expect(readFileSync(article.document, 'utf8')).toBe(`${ARTICLE}${PHRASE}`);
    expect(await leaveDialogs(app)).toEqual([]);
  });
});

test('quitter juste après une frappe : la phrase est dans le fichier, sans question', async () => {
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
    await typeAtEnd(window, PHRASE);
  } finally {
    await app.close();
  }
  expect(readFileSync(article.document, 'utf8')).toBe(`${ARTICLE}${PHRASE}`);
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(article.dir, { recursive: true, force: true });
});

for (const [id, label, accelerator] of [
  ['view-reload', 'Recharger', 'CmdOrCtrl+R'],
  ['view-force-reload', 'Forcer le rechargement', 'Shift+CmdOrCtrl+R'],
] as const) {
  test(`${label} (menu, ${accelerator}) juste après une frappe : la phrase est dans le fichier`, async () => {
    await withArticle(async (app, window, article) => {
      await markPage(window);
      await typeAtEnd(window, PHRASE);
      await clickMenuItem(app, id);

      await expect.poll(() => pageWasReloaded(window), { timeout: 15_000 }).toBe(true);
      expect(readFileSync(article.document, 'utf8')).toBe(`${ARTICLE}${PHRASE}`);
      expect(await leaveDialogs(app)).toEqual([]);

      // Même place dans le menu, même raccourci qu'avec le rôle qu'elle remplace.
      const item = await app.evaluate(({ Menu }, itemId) => {
        const menuItem = Menu.getApplicationMenu()?.getMenuItemById(itemId);
        return { label: menuItem?.label, accelerator: menuItem?.accelerator, visible: menuItem?.visible };
      }, id);
      expect(item).toEqual({ label, accelerator, visible: true });
    });
  });
}

// MARK: - Rester ou partir sans enregistrer

test('tampon sans titre non vide : chaque sortie demande, Rester garde le texte, Quitter part', async () => {
  await withArticle(async (app, window, article) => {
    await untitledBuffer(window, 'Une idée neuve.');
    await markPage(window);
    await answerLeaveDialog(app, 'stay');

    await closeWindow(app);
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(1);
    await expect(editor(window)).toContainText('Une idée neuve.');
    expect(await windowCount(app)).toBe(1);

    // Rester n'a rien laissé derrière lui : la fermeture suivante redemande.
    await closeWindow(app);
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(2);

    await quit(app);
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(3);
    expect(await windowCount(app)).toBe(1);

    await clickMenuItem(app, 'view-reload');
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(4);
    expect(await pageWasReloaded(window)).toBe(false);
    await expect(editor(window)).toContainText('Une idée neuve.');

    await answerLeaveDialog(app, 'leave');
    await closeWindow(app);
    await expect.poll(() => windowCount(app), { timeout: 10_000 }).toBe(0);
    expect(await dialogCount(app)).toBe(5);
    expect(readFileSync(article.document, 'utf8')).toBe(ARTICLE);
  });
});

test('Windows et Linux : la croix écrit, puis la dernière fenêtre fermée quitte sans seconde attente', async () => {
  await withArticle(async (app, window, article) => {
    // `window-all-closed` lit la plateforme à l'appel : c'est le chemin qui suit la croix hors de macOS.
    await app.evaluate(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
    });
    await typeAtEnd(window, PHRASE);

    const exited = app.waitForEvent('close');
    await closeWindow(app);
    await exited;

    expect(readFileSync(article.document, 'utf8')).toBe(`${ARTICLE}${PHRASE}`);
  });
});

test('Windows et Linux : Rester sur un tampon sans titre garde l’app ouverte, Quitter la ferme', async () => {
  await withArticle(async (app, window) => {
    await app.evaluate(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
    });
    await untitledBuffer(window, 'Une idée neuve.');
    await answerLeaveDialog(app, 'stay');

    await closeWindow(app);
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(1);
    expect(await windowCount(app)).toBe(1);
    await expect(editor(window)).toContainText('Une idée neuve.');

    await answerLeaveDialog(app, 'leave');
    const exited = app.waitForEvent('close');
    await closeWindow(app);
    await exited;
  });
});

test('tampon sans titre vide, ou document propre en lecture seule : aucune question', async () => {
  await withArticle(async (app, window, article) => {
    // Rien à écrire : le fichier refuserait, mais personne ne le lui demande.
    chmodSync(article.document, 0o444);
    await markPage(window);
    await clickMenuItem(app, 'view-reload');
    await expect.poll(() => pageWasReloaded(window), { timeout: 15_000 }).toBe(true);
    expect(await leaveDialogs(app)).toEqual([]);
    chmodSync(article.document, 0o644);

    // Après le rechargement : un tampon sans titre, vide.
    await expect(editor(window)).toBeVisible({ timeout: 20_000 });
    await closeWindow(app);
    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(0);
    expect(await leaveDialogs(app)).toEqual([]);
  });
});

test('autosave en échec (fichier en 0444), puis fermer : Rester garde le texte, et il s’écrit une fois l’accès revenu', async () => {
  await withArticle(async (app, window, article) => {
    chmodSync(article.document, 0o444);
    await typeAtEnd(window, PHRASE);
    await expect(window.locator('.status-toast--error')).toContainText('Enregistrement automatique impossible', {
      timeout: 15_000,
    });
    await answerLeaveDialog(app, 'stay');

    await closeWindow(app);
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(1);
    const [seen] = await leaveDialogs(app);
    expect(seen.message).toContain('pas pu être enregistré');
    expect(seen.buttons).toEqual(['Rester', 'Quitter sans enregistrer']);
    expect(await windowCount(app)).toBe(1);
    await expect(editor(window)).toContainText(PHRASE);
    expect(readFileSync(article.document, 'utf8')).toBe(ARTICLE);

    chmodSync(article.document, 0o644);
    await closeWindow(app);
    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(0);
    expect(await dialogCount(app)).toBe(1);
    expect(readFileSync(article.document, 'utf8')).toBe(`${ARTICLE}${PHRASE}`);
  });
});

test('écriture refusée (fichier en 0444), puis Quitter : la fenêtre part et le fichier n’a pas bougé', async () => {
  await withArticle(async (app, window, article) => {
    chmodSync(article.document, 0o444);
    await typeAtEnd(window, PHRASE);

    await closeWindow(app);
    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(0);
    expect(await dialogCount(app)).toBe(1);
    expect(readFileSync(article.document, 'utf8')).toBe(ARTICLE);
  });
});

test('écriture refusée (fichier en 0444), puis Cmd+Q : Rester ne quitte pas, Quitter sort et le fichier n’a pas bougé', async () => {
  await withArticle(async (app, window, article) => {
    chmodSync(article.document, 0o444);
    await typeAtEnd(window, PHRASE);
    await answerLeaveDialog(app, 'stay');

    await quit(app);
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(1);
    expect(await windowCount(app)).toBe(1);
    await expect(editor(window)).toContainText(PHRASE);

    await answerLeaveDialog(app, 'leave');
    const exited = app.waitForEvent('close');
    await quit(app);
    await exited;
    expect(readFileSync(article.document, 'utf8')).toBe(ARTICLE);
  });
});

for (const [language, stay, leave, untitledPart] of [
  ['en', 'Stay', 'Quit without saving', 'untitled'],
  ['de', 'Bleiben', 'Beenden ohne Speichern', 'unbenannte'],
] as const) {
  test(`dialogue et menu dans la langue de l’interface : ${language}`, async () => {
    const outcome = await launchApp({ language });
    if (outcome.kind === 'skip') {
      test.skip(true, outcome.reason);
      return;
    }
    const { app, window, userDataDir } = outcome.value;
    const menuTexts = JSON.parse(readFileSync(join(LOCALES, language, 'menu.json'), 'utf8')) as Record<string, string>;

    try {
      await expect(editor(window)).toBeVisible({ timeout: 20_000 });
      // Sans projet, l'éditeur est déjà un tampon sans titre.
      await typeAtEnd(window, 'Text.');
      await answerLeaveDialog(app, 'stay');

      await closeWindow(app);
      await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(1);
      const [seen] = await leaveDialogs(app);
      expect(seen.buttons).toEqual([stay, leave]);
      expect(seen.message).toBe(menuTexts.unsavedUntitledMessage);
      expect(seen.message).toContain(untitledPart);

      const labels = await app.evaluate(({ Menu }) =>
        ['view-reload', 'view-force-reload'].map((id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.label),
      );
      expect(labels).toEqual([menuTexts.reload, menuTexts.forceReload]);
    } finally {
      await closeApp(app);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}

// MARK: - Un renderer qui ne répond plus n'empêche jamais de partir

test('renderer bloqué : la fenêtre se ferme quand même', async () => {
  await withArticle(async (app, window) => {
    await window.evaluate(() => {
      setTimeout(() => {
        for (;;) {
          // La boucle infinie est le sujet du test.
        }
      }, 0);
    });
    await closeWindow(app);
    await expect.poll(() => windowCount(app), { timeout: 20_000 }).toBe(0);
    expect(await leaveDialogs(app)).toEqual([]);
  });
});

test('renderer bloqué : Cmd+Q sort quand même', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  await expect(editor(window)).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => {
    setTimeout(() => {
      for (;;) {
        // La boucle infinie est le sujet du test.
      }
    }, 0);
  });
  // `app.close()` ne rend la main qu'une fois le processus sorti : rester bloqué, c'est le délai du test.
  await app.close();
  rmSync(userDataDir, { recursive: true, force: true });
});

test('renderer disparu : la fenêtre se ferme quand même', async () => {
  await withArticle(async (app) => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
    });
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isCrashed()))
      .toBe(true);
    await closeWindow(app);
    await expect.poll(() => windowCount(app), { timeout: 20_000 }).toBe(0);
    expect(await leaveDialogs(app)).toEqual([]);
  });
});

// MARK: - Réessayer après un plantage

test('plantage de rendu, Réessayer : la phrase tapée avant lui est dans le fichier, puis la page se recharge', async () => {
  await withArticle(async (app, window, article) => {
    await markPage(window);
    await typeAtEnd(window, PHRASE);
    await crashRender(window);
    await retryButton(window).click();

    await expect.poll(() => pageWasReloaded(window), { timeout: 15_000 }).toBe(true);
    expect(readFileSync(article.document, 'utf8')).toBe(`${ARTICLE}${PHRASE}`);
  });
});

test('plantage de rendu, puis fermer la fenêtre : le filet survit au démontage de l’éditeur', async () => {
  await withArticle(async (app, window, article) => {
    await typeAtEnd(window, PHRASE);
    await crashRender(window);
    await closeWindow(app);

    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(0);
    expect(readFileSync(article.document, 'utf8')).toBe(`${ARTICLE}${PHRASE}`);
  });
});

test('plantage de rendu, écriture refusée : pas de rechargement, le message le dit, et le second essai écrit', async () => {
  await withArticle(async (app, window, article) => {
    await markPage(window);
    chmodSync(article.document, 0o444);
    await typeAtEnd(window, PHRASE);
    await crashRender(window);
    await retryButton(window).click();

    await expect(blockedMessage(window)).toContainText('pas pu être enregistré', { timeout: 10_000 });
    await expect(reloadAnywayButton(window)).toHaveText('Recharger quand même');
    expect(await pageWasReloaded(window)).toBe(false);
    expect(readFileSync(article.document, 'utf8')).toBe(ARTICLE);

    chmodSync(article.document, 0o644);
    await retryButton(window).click();
    await expect.poll(() => pageWasReloaded(window), { timeout: 15_000 }).toBe(true);
    expect(readFileSync(article.document, 'utf8')).toBe(`${ARTICLE}${PHRASE}`);
  });
});

test('plantage de rendu, écriture refusée : Recharger quand même recharge', async () => {
  await withArticle(async (app, window, article) => {
    await markPage(window);
    chmodSync(article.document, 0o444);
    await typeAtEnd(window, PHRASE);
    await crashRender(window);
    await retryButton(window).click();
    await reloadAnywayButton(window).click();

    await expect.poll(() => pageWasReloaded(window), { timeout: 15_000 }).toBe(true);
    expect(readFileSync(article.document, 'utf8')).toBe(ARTICLE);
  });
});

test('plantage de rendu sur un tampon sans titre : le message le dit, un refus se dit aussi, Enregistrer le met à l’abri, puis Réessayer recharge', async () => {
  await withArticle(async (app, window, article) => {
    const chosen = join(article.dir, 'une-idee.md');
    const chooseSavePath = (path: string) =>
      app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      }, path);
    await untitledBuffer(window, 'Une idée neuve.');
    await markPage(window);
    await crashRender(window);
    await retryButton(window).click();

    await expect(blockedMessage(window)).toContainText('sans titre', { timeout: 10_000 });
    expect(await pageWasReloaded(window)).toBe(false);

    // L'auteur suit le conseil affiché, et le système refuse : un dossier ne s'écrit pas, sur
    // aucun système. Ce refus se dit ici aussi, et rien n'est perdu.
    await chooseSavePath(article.dir);
    await sendMenu(app, 'menu:save-file');
    await expect(window.locator('.alert-dialog')).toContainText('Erreur lors de la sauvegarde', { timeout: 10_000 });
    await dismissAlerts(window);
    await expect(blockedMessage(window)).toContainText('sans titre');
    expect(await pageWasReloaded(window)).toBe(false);

    // Le menu vit au-dessus de la frontière : le texte est encore dans le store.
    await chooseSavePath(chosen);
    await sendMenu(app, 'menu:save-file');
    await expect.poll(() => (existsSync(chosen) ? readFileSync(chosen, 'utf8') : null), { timeout: 10_000 }).toBe(
      'Une idée neuve.',
    );

    await retryButton(window).click();
    await expect.poll(() => pageWasReloaded(window), { timeout: 15_000 }).toBe(true);
  });
});

test('un dialogue qui plante n’efface pas la page : l’écran d’erreur, et le filet écrit encore', async () => {
  await withArticle(async (app, window, article) => {
    chmodSync(article.document, 0o444);
    await typeAtEnd(window, PHRASE);
    await sendMenu(app, 'menu:save-file');
    await expect(window.locator('.alert-dialog')).toBeVisible({ timeout: 10_000 });

    await crashRender(window, '.alert-dialog');
    await expect(window.locator('.alert-dialog')).toHaveCount(0);

    chmodSync(article.document, 0o644);
    await closeWindow(app);
    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(0);
    expect(readFileSync(article.document, 'utf8')).toBe(`${ARTICLE}${PHRASE}`);
    expect(await leaveDialogs(app)).toEqual([]);
  });
});

// MARK: - Une seule demande, un seul accusé

test('deux fermetures et Cmd+Q en même temps : une seule demande, un seul accusé, un seul dialogue', async () => {
  await withArticle(async (app, window) => {
    await untitledBuffer(window, 'Une idée neuve.');
    await answerLeaveDialog(app, 'stay');
    await app.evaluate(({ ipcMain, BrowserWindow, app: electronApp }) => {
      const counters = globalThis as unknown as { __asked: number; __acks: number };
      counters.__asked = 0;
      counters.__acks = 0;
      ipcMain.on('app:flush-done', () => {
        counters.__acks += 1;
      });
      const win = BrowserWindow.getAllWindows()[0];
      const contents = win.webContents as unknown as { send: (channel: string, ...args: unknown[]) => void };
      const send = contents.send.bind(contents);
      contents.send = (channel, ...args) => {
        if (channel === 'app:flush-before-quit') counters.__asked += 1;
        send(channel, ...args);
      };
      win.close();
      win.close();
      electronApp.quit();
    });

    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(1);
    await window.waitForTimeout(500);
    const counts = await app.evaluate(() => {
      const { __asked, __acks } = globalThis as unknown as { __asked: number; __acks: number };
      return { asked: __asked, acks: __acks };
    });
    expect(counts).toEqual({ asked: 1, acks: 1 });
    expect(await dialogCount(app)).toBe(1);
    expect(await windowCount(app)).toBe(1);

    // Quitter vaut pour les trois gestes : la fenêtre part, et l'app sort.
    await answerLeaveDialog(app, 'leave');
    const exited = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow, app: electronApp }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.close();
      win.close();
      electronApp.quit();
    });
    await exited;
  });
});

test('macOS : fermer, rouvrir par le Dock, refermer, puis Cmd+Q : aucun état périmé, aucun dialogue en double', async () => {
  test.skip(process.platform !== 'darwin', 'Hors de macOS, fermer la dernière fenêtre quitte l’app.');
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const article = makeArticle();
  const reopen = async (): Promise<Page> => {
    const next = app.waitForEvent('window');
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit('activate');
    });
    const page = await next;
    await page.waitForLoadState('domcontentloaded');
    return page;
  };

  try {
    await openProject(app, window, article.projectJson);
    await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });
    await typeAtEnd(window, PHRASE);
    await closeWindow(app);
    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(0);
    expect(readFileSync(article.document, 'utf8')).toBe(`${ARTICLE}${PHRASE}`);

    // Le menu reste, sans fenêtre : recharger ne vise pas un objet détruit.
    await clickMenuItem(app, 'view-reload');
    expect(await windowCount(app)).toBe(0);

    // La fenêtre recréée a son propre passage : elle ne se ferme pas sans écrire.
    const second = await reopen();
    await openProject(app, second, article.projectJson);
    await expect(editor(second)).toContainText(PHRASE, { timeout: 20_000 });
    await typeAtEnd(second, ' Suite.');
    await closeWindow(app);
    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(0);
    expect(readFileSync(article.document, 'utf8')).toBe(`${ARTICLE}${PHRASE} Suite.`);
    expect(await dialogCount(app)).toBe(0);

    // Et elle pose sa question, une fois, à la fermeture comme à la sortie.
    const third = await reopen();
    await expect(editor(third)).toBeVisible({ timeout: 20_000 });
    await typeAtEnd(third, 'Une idée neuve.');
    await answerLeaveDialog(app, 'stay');
    await closeWindow(app);
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(1);
    expect(await windowCount(app)).toBe(1);

    // Le menu de la fenêtre recréée vise bien elle.
    await clickMenuItem(app, 'view-reload');
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(2);

    await quit(app);
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(3);
    await third.waitForTimeout(300);
    expect(await dialogCount(app)).toBe(3);
    expect(await windowCount(app)).toBe(1);
    await expect(editor(third)).toContainText('Une idée neuve.');
  } finally {
    await closeApp(app);
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(article.dir, { recursive: true, force: true });
  }
});

// MARK: - Pendant un changement de projet ou une renumérotation

/** `project:load` lent : la fenêtre pendant laquelle l'éditeur est détaché. */
const slowDownProjectLoad = (app: ElectronApplication, delay: number) =>
  app.evaluate(({ ipcMain }, ms) => {
    const handlers = (ipcMain as unknown as {
      _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
    })._invokeHandlers;
    const original = handlers.get('project:load');
    if (!original) throw new Error('project:load introuvable');
    handlers.set('project:load', async (...args: unknown[]) => {
      await new Promise((r) => setTimeout(r, ms));
      return original(...args);
    });
  }, delay);

for (const gesture of ['fermer', 'recharger', 'quitter'] as const) {
  test(`pendant un changement de projet, ${gesture} : le sortant est déjà écrit, aucune question, et l’entrant n’est pas touché`, async () => {
    const outcome = await launchApp();
    if (outcome.kind === 'skip') {
      test.skip(true, outcome.reason);
      return;
    }
    const { app, window, userDataDir } = outcome.value;
    const a = makeArticle();
    const B_TEXT = '# Article B\n\nDouze mille mots.\n';
    const b = makeArticle('Projet B', B_TEXT);

    try {
      await openProject(app, window, a.projectJson);
      await expect(editor(window)).toContainText('Huit mille mots', { timeout: 20_000 });
      await typeAtEnd(window, PHRASE);
      await slowDownProjectLoad(app, 3_000);
      await openProject(app, window, b.projectJson);
      await expect(editor(window)).toContainText('Ouverture du projet', { timeout: 10_000 });

      if (gesture === 'fermer') {
        await closeWindow(app);
        await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(0);
        expect(await leaveDialogs(app)).toEqual([]);
      } else if (gesture === 'recharger') {
        await markPage(window);
        await clickMenuItem(app, 'view-reload');
        await expect.poll(() => pageWasReloaded(window), { timeout: 15_000 }).toBe(true);
        expect(await leaveDialogs(app)).toEqual([]);
      }
    } finally {
      await closeApp(app);
    }
    expect(readFileSync(a.document, 'utf8')).toBe(`${ARTICLE}${PHRASE}`);
    expect(readFileSync(b.document, 'utf8')).toBe(B_TEXT);
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  });
}

test('tampon sans titre abandonné avec accord, puis fermer pendant le changement de projet : pas de seconde question', async () => {
  await withArticle(async (app, window) => {
    const b = makeArticle('Projet B');
    try {
      await untitledBuffer(window, 'Une idée neuve.');
      await slowDownProjectLoad(app, 3_000);
      await openProject(app, window, b.projectJson);
      await expect(window.locator('.confirm-dialog')).toContainText('sans titre', { timeout: 10_000 });
      await window.locator('.confirm-dialog .confirm-dialog-btn-confirm').click();
      await expect(editor(window)).toContainText('Ouverture du projet', { timeout: 10_000 });

      await closeWindow(app);
      await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(0);
      expect(await leaveDialogs(app)).toEqual([]);
    } finally {
      rmSync(b.dir, { recursive: true, force: true });
    }
  });
});

function makeBook(): { dir: string; projectJson: string; chapters: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-fermeture-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  mkdirSync(join(dir, 'chapters'));
  const manifest = [1, 2, 3].map((n) => ({
    id: `c${n}`,
    title: `Chapitre ${n}`,
    filePath: `chapters/0${n}.md`,
    order: n - 1,
    kind: 'chapter',
  }));
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000053',
      name: 'Livre E2E',
      type: 'book',
      chapters: manifest,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const chapters = manifest.map((chapter, index) => {
    const file = join(dir, chapter.filePath);
    const note = (index + 1) * 5;
    writeFileSync(file, `# Chapitre ${index + 1}\n\nTexte[^${note}].\n\n[^${note}]: Note ${index + 1}.\n`);
    return file;
  });
  return { dir, projectJson, chapters };
}

/** Le premier appel de note de chaque chapitre : tous renumérotés, ou aucun. */
const firstNotes = (chapters: string[]) =>
  chapters.map((file) => readFileSync(file, 'utf8').match(/\[\^(\d+)\]/)?.[1]);

/**
 * Un disque lent : une renumérotation à laquelle on a le temps de couper la parole, ou une
 * écriture plus lente que le filet. `fastFile` : ce fichier-là s'écrit sans attendre.
 */
const slowDownSaves = (app: ElectronApplication, delay: number, fastFile?: string) =>
  app.evaluate(({ ipcMain }, { ms, fast }) => {
    const handlers = (ipcMain as unknown as {
      _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
    })._invokeHandlers;
    const original = handlers.get('editor:save-file');
    if (!original) throw new Error('editor:save-file introuvable');
    handlers.set('editor:save-file', async (...args: unknown[]) => {
      if (!fast || !String(args[1]).endsWith(fast)) await new Promise((r) => setTimeout(r, ms));
      return original(...args);
    });
  }, { ms: delay, fast: fastFile });

/**
 * Un disque mort ou un partage réseau coupé : l'écriture part et ne revient jamais. Les
 * promesses sont retenues, comme le ferait un vrai appel au disque : ramassées, Electron
 * rejetterait l'appel, et ce ne serait plus une écriture sans réponse.
 */
const hangSaves = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as {
      _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
    })._invokeHandlers;
    const held: unknown[] = [];
    handlers.set('editor:save-file', () => new Promise((resolve) => held.push(resolve)));
  });

test('quitter pendant une renumérotation : aucune question, et le manuscrit n’est pas laissé à mi-chemin', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const book = makeBook();

  try {
    await openProject(app, window, book.projectJson);
    await expect(editor(window)).toContainText('Chapitre 1', { timeout: 20_000 });
    await slowDownSaves(app, 200);
    await window.locator('button[title="Renuméroter les notes"]').first().click();
  } finally {
    await app.close();
  }
  expect(firstNotes(book.chapters)).toEqual(['1', '2', '3']);
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(book.dir, { recursive: true, force: true });
});

test('fermer pendant une renumérotation qui dure : la frappe du tampon s’écrit à temps, et la fenêtre part sans question', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const book = makeBook();

  try {
    await openProject(app, window, book.projectJson);
    await expect(editor(window)).toContainText('Chapitre 1', { timeout: 20_000 });
    await typeAtEnd(window, 'Avant.');
    await expect.poll(() => readFileSync(book.chapters[0], 'utf8'), { timeout: 15_000 }).toContain('Avant.');
    // Les autres chapitres à 3 s l'écriture : plus que ce que le filet accepte d'attendre.
    // Le chapitre ouvert s'écrit sans attendre : ce parcours regarde le verrou, pas le disque.
    await slowDownSaves(app, 3_000, 'chapters/01.md');
    await window.locator('button[title="Renuméroter les notes"]').first().click();
    await typeAtEnd(window, ' Pendant.');
    await closeWindow(app);
    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(0);
    expect(readFileSync(book.chapters[0], 'utf8')).toContain(' Pendant.');
    expect(await leaveDialogs(app)).toEqual([]);
  } finally {
    await closeApp(app);
  }
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(book.dir, { recursive: true, force: true });
});

test('fermer pendant une renumérotation, sur un disque trop lent pour le tampon : la question, et Rester garde la frappe', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const book = makeBook();

  try {
    await openProject(app, window, book.projectJson);
    await expect(editor(window)).toContainText('Chapitre 1', { timeout: 20_000 });
    await typeAtEnd(window, 'Avant.');
    await expect.poll(() => readFileSync(book.chapters[0], 'utf8'), { timeout: 15_000 }).toContain('Avant.');
    await slowDownSaves(app, 1_500);
    await window.locator('button[title="Renuméroter les notes"]').first().click();
    await typeAtEnd(window, ' Pendant.');
    await answerLeaveDialog(app, 'stay');
    await closeWindow(app);

    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(1);
    expect(await windowCount(app)).toBe(1);
    await expect(editor(window)).toContainText(' Pendant.');
    await expect.poll(() => readFileSync(book.chapters[0], 'utf8'), { timeout: 20_000 }).toContain(' Pendant.');
  } finally {
    await closeApp(app);
  }
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(book.dir, { recursive: true, force: true });
});

// MARK: - Une écriture sans réponse, avec un renderer vivant

for (const [gestureName, gesture] of [
  ['la croix', closeWindow],
  ['Cmd+Q', quit],
] as const) {
  test(`écriture plus lente que le filet, ${gestureName} : la question plutôt qu’un départ muet, et Rester laisse le texte arriver`, async () => {
    await withArticle(async (app, window, article) => {
      await slowDownSaves(app, 6_000);
      await typeAtEnd(window, PHRASE);
      await answerLeaveDialog(app, 'stay');
      await gesture(app);

      await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(1);
      const [seen] = await leaveDialogs(app);
      expect(seen.message).toContain('pas pu être enregistré');
      expect(seen.buttons).toEqual(['Rester', 'Quitter sans enregistrer']);
      expect(await windowCount(app)).toBe(1);
      await expect(editor(window)).toContainText(PHRASE);

      // L'écriture n'était pas annulée : elle arrive, et l'état suit.
      await expect
        .poll(() => readFileSync(article.document, 'utf8'), { timeout: 15_000 })
        .toBe(`${ARTICLE}${PHRASE}`);
      await closeWindow(app);
      await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(0);
      expect(await dialogCount(app)).toBe(1);
    });
  });
}

test('Windows et Linux : écriture plus lente que le filet, la croix demande avant que la dernière fenêtre emporte l’app', async () => {
  await withArticle(async (app, window) => {
    await app.evaluate(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
    });
    await slowDownSaves(app, 6_000);
    await typeAtEnd(window, PHRASE);
    await answerLeaveDialog(app, 'stay');

    await closeWindow(app);
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(1);
    expect(await windowCount(app)).toBe(1);

    await answerLeaveDialog(app, 'leave');
    const exited = app.waitForEvent('close');
    await closeWindow(app);
    await exited;
  });
});

test('écriture qui ne répond jamais : fermer, Cmd+Q et recharger demandent, et Quitter part', async () => {
  await withArticle(async (app, window, article) => {
    await hangSaves(app);
    await markPage(window);
    await typeAtEnd(window, PHRASE);
    await answerLeaveDialog(app, 'stay');

    await closeWindow(app);
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(1);
    expect(await windowCount(app)).toBe(1);

    await quit(app);
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(2);
    expect(await windowCount(app)).toBe(1);

    await clickMenuItem(app, 'view-reload');
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(3);
    expect(await pageWasReloaded(window)).toBe(false);
    await expect(editor(window)).toContainText(PHRASE);

    await answerLeaveDialog(app, 'leave');
    await closeWindow(app);
    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(0);
    expect(await dialogCount(app)).toBe(4);
    expect(readFileSync(article.document, 'utf8')).toBe(ARTICLE);
  });
});

test('écriture qui ne répond jamais, et la page occupée quand son plafond tombe : le main demande quand même', async () => {
  await withArticle(async (app, window) => {
    await hangSaves(app);
    await typeAtEnd(window, PHRASE);
    await answerLeaveDialog(app, 'stay');
    // La réponse de la page arrivera après le délai du main. Elle a reçu la demande : elle n'est pas bloquée.
    await window.evaluate(() => {
      setTimeout(() => {
        const end = Date.now() + 2_000;
        while (Date.now() < end) {
          // L'attente active est le sujet du test.
        }
      }, 3_000);
    });

    await closeWindow(app);
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(1);
    expect(await windowCount(app)).toBe(1);
    await expect(editor(window)).toContainText(PHRASE);
  });
});

test('une page qui répond sans rapport à chaque demande : la question plutôt qu’une fenêtre impossible à fermer, et Quitter part', async () => {
  await withArticle(async (app, window, article) => {
    await hangSaves(app);
    await typeAtEnd(window, PHRASE);
    // Le pont le permet : `flushDone` est exposé à la page, et rien ne l'oblige à dire quelque chose.
    await window.evaluate(() => {
      const { lifecycle } = (window as unknown as {
        electron: { lifecycle: { onFlushBeforeQuit: (callback: () => void) => void; flushDone: () => void } };
      }).electron;
      lifecycle.onFlushBeforeQuit(() => lifecycle.flushDone());
    });
    await answerLeaveDialog(app, 'stay');

    await closeWindow(app);
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(1);
    const [seen] = await leaveDialogs(app);
    expect(seen.message).toContain('pas pu être enregistré');
    expect(await windowCount(app)).toBe(1);
    await expect(editor(window)).toContainText(PHRASE);

    await quit(app);
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(2);
    expect(await windowCount(app)).toBe(1);

    await answerLeaveDialog(app, 'leave');
    await closeWindow(app);
    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(0);
    expect(await dialogCount(app)).toBe(3);
    expect(readFileSync(article.document, 'utf8')).toBe(ARTICLE);
  });
});

test('plantage de rendu, écriture qui ne répond jamais : Réessayer ne reste pas figé, le message et le secours arrivent', async () => {
  await withArticle(async (app, window) => {
    await hangSaves(app);
    await markPage(window);
    await typeAtEnd(window, PHRASE);
    await crashRender(window);
    await retryButton(window).click();

    await expect(blockedMessage(window)).toContainText('pas pu être enregistré', { timeout: 10_000 });
    await expect(retryButton(window)).toBeEnabled();
    expect(await pageWasReloaded(window)).toBe(false);

    // Le menu vit au-dessus de la frontière : il pose la même question, et ne recharge pas sans réponse.
    await answerLeaveDialog(app, 'stay');
    await clickMenuItem(app, 'view-reload');
    await expect.poll(() => dialogCount(app), { timeout: 10_000 }).toBe(1);
    expect(await pageWasReloaded(window)).toBe(false);

    await reloadAnywayButton(window).click();
    await expect.poll(() => pageWasReloaded(window), { timeout: 15_000 }).toBe(true);
  });
});
