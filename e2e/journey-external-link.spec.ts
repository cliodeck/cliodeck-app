/**
 * Un lien web ne s'ouvre dans le navigateur que sur un geste de l'historien (E1).
 *
 * Electron ne dit pas si une navigation vient d'un geste, et le garde de navigation ouvrait toute
 * navigation externe : une balise `<meta http-equiv="refresh">` présente dans la page faisait
 * ouvrir son URL, sans aucun clic (mesuré par L08-1, #226). Un texte piégé — extrait de PDF,
 * archive, note, réponse du modèle — pouvait donc ouvrir seul une page dans le navigateur.
 *
 * Rien n'est jamais ouvert ni visité : `shell.openExternal` est remplacé côté main par un
 * enregistreur, et toutes les URL visent un serveur local qui compte ses visites. Le chat est le
 * vrai, servi par un faux Ollama local.
 *
 * Deux défauts « deux onglets » ont déjà touché ce chemin (écouteurs posés deux fois ;
 * `will-frame-navigate` qui couvre aussi le frame principal) : chaque geste doit donner
 * exactement un appel. Un témoin le prouve sans attendre un délai : un second lien, activé
 * ensuite, ne s'inscrit qu'après tout doublon du premier.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';
import { startFakeOllama, type FakeOllama } from './_helpers/fake-ollama';

interface Session {
  app: ElectronApplication;
  window: Page;
  ollama: FakeOllama;
  target: Server;
  /** Base des URL du serveur local, `http://127.0.0.1:<port>`. */
  base: string;
  /** Visites reçues par le serveur local : doit rester à zéro. */
  hits: () => number;
  project: string;
}

const toClean: string[] = [];

test.afterEach(() => {
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(answer: (base: string) => string): Promise<Session | null> {
  let hits = 0;
  const target = createServer((_req, res) => {
    hits += 1;
    res.end('visite');
  });
  await new Promise<void>((done) => target.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;

  const ollama = await startFakeOllama(answer(base));
  toClean.push(ollama.userDataDir);
  const outcome = await launchApp({ userDataDir: ollama.userDataDir });
  if (outcome.kind === 'skip') {
    await ollama.close();
    target.close();
    test.skip(true, outcome.reason);
    return null;
  }
  const { app, window } = outcome.value;

  const project = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-lien-'));
  toClean.push(project);
  mkdirSync(join(project, '.cliodeck'), { recursive: true });
  const projectJson = join(project, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-0000000000e1',
      name: 'Projet E2E liens',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(project, 'document.md'), '# Titre\n\nUn paragraphe.\n');

  await app.evaluate(({ dialog, shell }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    const opened: string[] = [];
    (globalThis as unknown as { __opened: string[] }).__opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Un paragraphe', { timeout: 20_000 });

  return { app, window, ollama, target, base, hits: () => hits, project };
}

async function stop({ app, ollama, target }: Session): Promise<void> {
  await app.close();
  await ollama.close();
  target.close();
}

/** Les URL que l'app a demandé d'ouvrir dans le navigateur. */
const opened = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => [...(globalThis as unknown as { __opened: string[] }).__opened]);

/** Les navigations externes refusées, au journal de sécurité du projet. */
function refused(project: string): string[] {
  let raw = '';
  try {
    raw = readFileSync(join(project, '.cliodeck', 'security-events.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { kind: string; url?: string })
    .filter((e) => e.kind === 'external_navigation_blocked')
    .map((e) => e.url ?? '');
}

/** L'adresse de la fenêtre et la présence de l'app, lues par le main. */
const appWindowState = (app: ElectronApplication): Promise<{ url: string; modeBar: boolean }> =>
  app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    return {
      url: contents.getURL(),
      modeBar: (await contents.executeJavaScript("document.querySelector('.workspace-mode-bar') !== null")) as boolean,
    };
  });

/** Les cadres que la CSP de la page a refusé de charger (`frame-src`), par origine. */
const framingBlocked = (window: Page): Promise<string[]> =>
  window.evaluate(() => (window as unknown as { __framingBlocked?: string[] }).__framingBlocked ?? []);

test('une navigation sans geste n’ouvre rien : meta refresh, location, sous-frame, clic de script, nouvelle fenêtre', async () => {
  const session = await start(() => 'Réponse sans lien.');
  if (!session) return;
  const { app, window, base, project } = session;
  /** L'URL a été refusée par le garde ; rien n'a été ouvert. */
  const expectRefused = async (url: string): Promise<void> => {
    await expect
      .poll(async () => ({ opened: await opened(app), refused: refused(project).includes(url) }), { timeout: 15_000 })
      .toEqual({ opened: [], refused: true });
  };
  try {
    // Le vecteur mesuré par L08-1 : une balise meta refresh dans le DOM de la fenêtre.
    await window.evaluate((url) => {
      const meta = document.createElement('meta');
      meta.httpEquiv = 'refresh';
      meta.content = `0;url=${url}`;
      meta.id = 'piege';
      document.head.append(meta);
    }, `${base}/refresh`);
    await expectRefused(`${base}/refresh`);
    await window.evaluate(() => document.getElementById('piege')?.remove());

    // La page change elle-même son adresse.
    await window.evaluate((url) => {
      window.location.href = url;
    }, `${base}/location`);
    await expectRefused(`${base}/location`);

    // Un sous-frame (comme l'aperçu de présentation). La CSP de la page (`frame-src`, à défaut
    // `default-src 'self'`) l'arrête aujourd'hui avant le garde, qui reste la seconde ligne
    // (tests unitaires) : l'un ou l'autre suffit, mais rien ne doit s'ouvrir.
    await window.evaluate((url) => {
      const blocked: string[] = [];
      (window as unknown as { __framingBlocked: string[] }).__framingBlocked = blocked;
      document.addEventListener('securitypolicyviolation', (e) => blocked.push(e.blockedURI));
      const frame = document.createElement('iframe');
      frame.id = 'cadre-piege';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.srcdoc = `<meta http-equiv="refresh" content="0;url=${url}">`;
      document.body.append(frame);
    }, `${base}/cadre`);
    await expect
      .poll(
        async () => ({
          opened: await opened(app),
          stopped:
            refused(project).includes(`${base}/cadre`) ||
            (await framingBlocked(window)).some((uri) => uri.startsWith(base)),
        }),
        { timeout: 15_000 },
      )
      .toEqual({ opened: [], stopped: true });
    await window.evaluate(() => document.getElementById('cadre-piege')?.remove());

    // Un clic simulé par un script n'est pas un geste : `isTrusted` est faux.
    await window.evaluate((url) => {
      const a = document.createElement('a');
      a.href = url;
      a.textContent = 'piège';
      document.body.append(a);
      a.click();
      a.remove();
    }, `${base}/script`);
    await expectRefused(`${base}/script`);

    // Une nouvelle fenêtre demandée par la page, sans geste : `window.open`, puis un lien
    // `target=_blank` cliqué par un script. Refusée sur tout WebContents, et dite au journal.
    await window.evaluate((url) => {
      window.open(url);
    }, `${base}/fenetre`);
    await expectRefused(`${base}/fenetre`);
    await window.evaluate((url) => {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.textContent = 'piège';
      document.body.append(a);
      a.click();
      a.remove();
    }, `${base}/onglet`);
    await expectRefused(`${base}/onglet`);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

    // La fenêtre est restée l'app. Vu du main : Playwright attend la fin des navigations que le
    // garde a annulées, et ses localisateurs resteraient bloqués.
    expect(await appWindowState(app)).toEqual({ url: expect.stringMatching(/^file:/), modeBar: true });
    expect(session.hits()).toBe(0);
  } finally {
    await stop(session);
  }
});

test('un lien d’une réponse du chat s’ouvre une fois par geste : clic, Cmd+clic, clic du milieu, Entrée, double-clic', async () => {
  const session = await start(
    (base) => `Voir [l'inventaire](${base}/inventaire) et [le fonds](${base}/fonds).`,
  );
  if (!session) return;
  const { window, base } = session;
  const inventaire = `${base}/inventaire`;
  const fonds = `${base}/fonds`;
  try {
    await window.locator('.workspace-mode-bar').getByRole('button', { name: 'Brainstormer' }).click();
    await window.locator('.center-panel textarea').first().fill('Où sont les archives ?');
    await window.keyboard.press('ControlOrMeta+Enter');
    const answer = window.locator('.message-bubble.assistant .message-markdown').last();
    const first = answer.getByRole('link', { name: "l'inventaire" });
    const second = answer.getByRole('link', { name: 'le fonds' });
    await expect(second).toBeVisible({ timeout: 30_000 });

    const expected: string[] = [];
    const expectOpened = async (url: string): Promise<void> => {
      expected.push(url);
      await expect.poll(() => opened(session.app), { timeout: 15_000 }).toEqual(expected);
    };

    // Clic, puis le second lien en témoin : un doublon du premier serait arrivé avant lui.
    await first.click();
    await expectOpened(inventaire);
    await second.click();
    await expectOpened(fonds);

    await first.click({ modifiers: ['ControlOrMeta'] });
    await expectOpened(inventaire);

    await second.click({ button: 'middle' });
    await expectOpened(fonds);

    await first.focus();
    await window.keyboard.press('Enter');
    await expectOpened(inventaire);

    // Un double-clic : un seul onglet. Le témoin suit.
    await second.dblclick();
    await expectOpened(fonds);
    await first.click();
    await expectOpened(inventaire);

    // Aucun geste n'a laissé passer de navigation : rien au journal.
    expect(refused(session.project)).toEqual([]);

    // URL échangée pendant le clic : un écouteur de la page réécrit le lien et change l'adresse.
    // Le preload a lu le lien avant lui ; la navigation qu'il lance est refusée. Souris réelle
    // plutôt que `click()` : Playwright attendrait la fin de la navigation annulée.
    const box = await first.boundingBox();
    if (!box) throw new Error('lien sans boîte');
    await window.evaluate((url) => {
      document.addEventListener(
        'click',
        (event) => {
          const a = (event.target as Element).closest('a');
          if (a) a.href = url;
          window.location.href = url;
        },
        { capture: true, once: true },
      );
    }, `${base}/echange`);
    await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    expected.push(inventaire);
    await expect
      .poll(async () => ({ opened: await opened(session.app), refused: refused(session.project) }), { timeout: 15_000 })
      .toEqual({ opened: expected, refused: [`${base}/echange`] });

    expect(await appWindowState(session.app)).toEqual({ url: expect.stringMatching(/^file:/), modeBar: true });
    expect(session.hits()).toBe(0);
  } finally {
    await stop(session);
  }
});

test('le lien d’aide des réglages (clé d’API Zotero) s’ouvre toujours', async () => {
  const session = await start(() => 'Réponse sans lien.');
  if (!session) return;
  const { window } = session;
  try {
    await window.evaluate(() => {
      window.dispatchEvent(new CustomEvent('show-settings-modal'));
    });
    await expect(window.getByRole('heading', { name: 'Paramètres' })).toBeVisible({ timeout: 15_000 });
    // Section repliée par défaut. Avant le correctif, ce lien `target="_blank"` n'ouvrait rien :
    // `setWindowOpenHandler` refuse toute nouvelle fenêtre.
    await window.getByRole('button', { name: 'Zotero', exact: true }).first().click();
    const help = window.getByRole('link', { name: 'Obtenir une clé API' });
    await help.click();
    await expect.poll(() => opened(session.app), { timeout: 15_000 }).toEqual(['https://www.zotero.org/settings/keys']);
    expect(refused(session.project)).toEqual([]);
  } finally {
    await stop(session);
  }
});
