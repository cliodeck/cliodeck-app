/**
 * Un `ideas.json` abîmé ou inaccessible, dans la vraie app : le preload, les vrais handlers, le
 * vrai disque. Avant, le fichier était pris pour une liste vide, et la première action
 * l'écrasait : 40 idées perdues pour une seule créée (S15-1-2).
 *
 * Et une idée tapée juste avant de quitter : seul le blur d'un champ l'écrivait, et ni `Cmd+Q`
 * ni la croix n'en font un.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';

interface ProjectOnDisk {
  dir: string;
  projectJson: string;
  ideasJson: string;
}

function makeProject(ideasContent?: string | Buffer): ProjectOnDisk {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-idees-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000071',
      name: 'Projet E2E',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'document.md'), '# Projet E2E\n');
  const ideasJson = join(dir, '.cliodeck', 'ideas.json');
  if (ideasContent !== undefined) writeFileSync(ideasJson, ideasContent);
  return { dir, projectJson, ideasJson };
}

const idea = (title: string) => ({
  id: `idee-${title}`,
  title,
  content: 'Contenu.',
  tags: [],
  links: [],
  origin: { type: 'manual' },
  createdAt: '2026-05-06T10:00:00.000Z',
  updatedAt: '2026-05-06T10:00:00.000Z',
});

const ideasFile = (...titles: string[]) => JSON.stringify({ ideas: titles.map(idea) }, null, 2);

const backups = (project: ProjectOnDisk) =>
  readdirSync(join(project.dir, '.cliodeck')).filter((name) => name.startsWith('ideas.json.illisible-'));

/** Demande le projet au dialogue natif, sans attendre : hors du mode Écrire, l'éditeur est caché. */
async function pickProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
}

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await pickProject(app, window, projectJson);
  await window.locator('.codemirror-editor .cm-content').waitFor({ timeout: 20_000 });
}

async function goToTab(window: Page, tab: 'Idées' | 'Tableau'): Promise<void> {
  await window.locator('.workspace-mode-bar button', { hasText: 'Brainstormer' }).click();
  await window.locator('.brainstorm-panel__tab', { hasText: tab }).click();
}

const banner = (window: Page) => window.locator('.brainstorm-panel__ideas-notice');

async function withApp(run: (app: ElectronApplication, window: Page) => Promise<void>): Promise<void> {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  try {
    await run(app, window);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

test('ideas.json tronqué : mis de côté, la bannière donne le chemin, et la première idée n’écrase rien', async () => {
  const whole = ideasFile(...Array.from({ length: 40 }, (_, i) => `Idée ${i}`));
  const truncated = whole.slice(0, Math.floor(whole.length * 0.6));
  const project = makeProject(truncated);
  try {
    await withApp(async (app, window) => {
      await openProject(app, window, project.projectJson);
      await goToTab(window, 'Idées');

      await expect(banner(window)).toBeVisible({ timeout: 10_000 });
      expect(backups(project)).toHaveLength(1);
      await expect(banner(window)).toContainText(backups(project)[0]);
      await expect(banner(window)).toContainText('mis de côté');
      expect(readFileSync(join(project.dir, '.cliodeck', backups(project)[0]), 'utf8')).toBe(truncated);
      expect(existsSync(project.ideasJson)).toBe(false);

      await window.locator('button[title="Nouvelle idée"]').first().click();
      await expect.poll(() => existsSync(project.ideasJson)).toBe(true);
      expect(JSON.parse(readFileSync(project.ideasJson, 'utf8')).ideas).toHaveLength(1);

      // Le tableau et un aller-retour de mode : la bannière reste, sans nouvelle mise de côté.
      await goToTab(window, 'Tableau');
      await expect(banner(window)).toBeVisible();
      await window.locator('.workspace-mode-bar button', { hasText: 'Écrire' }).click();
      await goToTab(window, 'Idées');
      await expect(banner(window)).toBeVisible();
      await expect(window.locator('.ideas-panel__item')).toHaveCount(1);
      expect(backups(project)).toHaveLength(1);
    });

    // Session suivante : un fichier sain, plus de bannière, et la mise de côté reste.
    await withApp(async (app, window) => {
      await openProject(app, window, project.projectJson);
      await goToTab(window, 'Idées');
      await expect(window.locator('.ideas-panel__item')).toHaveCount(1);
      await expect(banner(window)).toHaveCount(0);
      expect(backups(project)).toHaveLength(1);
    });
  } finally {
    rmSync(project.dir, { recursive: true, force: true });
  }
});

test('le fichier réparé et remis à sa place pendant la session : la nouvelle idée le rejoint, sans rien écraser', async () => {
  const whole = ideasFile(...Array.from({ length: 40 }, (_, i) => `Idée ${i}`));
  const project = makeProject(whole.slice(0, Math.floor(whole.length * 0.6)));
  try {
    await withApp(async (app, window) => {
      await openProject(app, window, project.projectJson);
      await goToTab(window, 'Idées');
      await expect(banner(window)).toBeVisible({ timeout: 10_000 });

      // Ce que la bannière invite à faire : réparer le fichier indiqué, puis le remettre.
      const backup = join(project.dir, '.cliodeck', backups(project)[0]);
      writeFileSync(backup, whole);
      renameSync(backup, project.ideasJson);

      await window.locator('button[title="Nouvelle idée"]').first().click();

      await expect(window.locator('.ideas-panel__item')).toHaveCount(41, { timeout: 10_000 });
      await expect
        .poll(() => JSON.parse(readFileSync(project.ideasJson, 'utf8')).ideas.length, { timeout: 10_000 })
        .toBe(41);
      // Le chemin qu'elle donnait n'existe plus : elle n'a plus rien à dire.
      await expect(banner(window)).toHaveCount(0);
    });
  } finally {
    rmSync(project.dir, { recursive: true, force: true });
  }
});

// C40 puis C41 : le fichier sain recopié (`cp`), la copie mise de côté restant en place, donc la
// bannière aussi. Des idées sans position : le Tableau doit les placer.
for (const tab of ['Idées', 'Tableau'] as const) {
  test(`fichier sain recopié à côté de sa mise de côté, sur l’onglet ${tab} : les idées reviennent sans changer d’onglet, et la bannière reste`, async () => {
    const titles = Array.from({ length: 10 }, (_, i) => `Revenue ${i}`);
    const project = makeProject();
    const saneCopy = join(project.dir, 'ideas-sain.json');
    writeFileSync(saneCopy, ideasFile(...titles));
    writeFileSync(project.ideasJson, readFileSync(saneCopy).subarray(0, 20));
    try {
      await withApp(async (app, window) => {
        await openProject(app, window, project.projectJson);
        await window.locator('.workspace-mode-bar button', { hasText: 'Brainstormer' }).click();
        await expect(banner(window)).toBeVisible({ timeout: 10_000 });
        await window.locator('.brainstorm-panel__tab', { hasText: tab }).click();
        const backup = backups(project);
        expect(backup).toHaveLength(1);

        copyFileSync(saneCopy, project.ideasJson);
        await window.locator('button[title="Nouvelle idée"]').first().click();
        await expect
          .poll(() => existsSync(project.ideasJson) && JSON.parse(readFileSync(project.ideasJson, 'utf8')).ideas.length, {
            timeout: 10_000,
          })
          .toBe(titles.length + 1);

        await expect(window.locator('.brainstorm-panel__tab.is-active')).toContainText(tab);
        if (tab === 'Idées') {
          await expect(window.locator('.ideas-panel__item')).toHaveCount(titles.length + 1);
          for (const title of titles) {
            await expect(window.locator('.ideas-panel__item', { hasText: title })).toBeVisible();
          }
        } else {
          const cards = window.locator('.ideas-canvas__card');
          await expect(cards).toHaveCount(titles.length + 1);
          // Avant, les dix revenues s'empilaient en (0,0), sous la barre d'outils, jusqu'au remontage.
          const spots = await cards.evaluateAll((all) =>
            all.map((card) => `${(card as HTMLElement).style.left},${(card as HTMLElement).style.top}`),
          );
          expect(new Set(spots).size).toBe(titles.length + 1);
        }
        await expect(banner(window)).toContainText(backup[0]);
        expect(backups(project)).toEqual(backup);
      });
    } finally {
      rmSync(project.dir, { recursive: true, force: true });
    }
  });
}

test('qui reste sur le chat le sait aussi, et la bannière survit à un aller-retour et à Cmd+R', async () => {
  const whole = ideasFile(...Array.from({ length: 40 }, (_, i) => `Idée ${i}`));
  const project = makeProject(whole.slice(0, Math.floor(whole.length * 0.6)));
  const other = makeProject(ideasFile('Febvre'));
  try {
    await withApp(async (app, window) => {
      await openProject(app, window, project.projectJson);
      await window.locator('.workspace-mode-bar button', { hasText: 'Brainstormer' }).click();

      await expect(banner(window)).toBeVisible({ timeout: 10_000 });
      await expect(banner(window)).toContainText(backups(project)[0]);
      await expect(window.locator('.brainstorm-panel__tab.is-active')).toContainText('Chat');

      // Un aller-retour, le chat à l'écran tout du long.
      await pickProject(app, window, other.projectJson);
      await window.locator('.brainstorm-panel__tab', { hasText: 'Idées' }).click();
      await expect(window.locator('.ideas-panel__item', { hasText: 'Febvre' })).toBeVisible({ timeout: 15_000 });
      await expect(banner(window)).toHaveCount(0);
      await window.locator('.brainstorm-panel__tab', { hasText: 'Chat' }).click();
      await pickProject(app, window, project.projectJson);
      await expect(banner(window)).toContainText(backups(project)[0], { timeout: 15_000 });

      // Le menu : `Cmd+R` recharge après avoir écrit, et aucun projet n'est rouvert tout seul.
      await window.reload();
      await window.waitForLoadState('domcontentloaded');
      await pickProject(app, window, project.projectJson);
      await window.locator('.workspace-mode-bar button', { hasText: 'Brainstormer' }).click();
      await expect(banner(window)).toContainText(backups(project)[0], { timeout: 15_000 });
      expect(backups(project)).toHaveLength(1);
    });
  } finally {
    rmSync(project.dir, { recursive: true, force: true });
    rmSync(other.dir, { recursive: true, force: true });
  }
});

test('regarder le Tableau d’un fichier en lecture seule ne dit rien et ne retient pas la bascule', async () => {
  test.skip(process.getuid?.() === 0, 'root écrit partout');
  test.skip(process.platform === 'win32', 'chmod ne retire pas l’écriture sous Windows');
  const project = makeProject(ideasFile('Braudel'));
  const other = makeProject(ideasFile('Febvre'));
  const content = readFileSync(project.ideasJson);
  chmodSync(project.ideasJson, 0o444);
  chmodSync(join(project.dir, '.cliodeck'), 0o555);
  try {
    await withApp(async (app, window) => {
      await openProject(app, window, project.projectJson);
      await goToTab(window, 'Tableau');
      await window.locator('.ideas-canvas__card', { hasText: 'Braudel' }).click();
      await window.waitForTimeout(500);
      await expect(banner(window)).toHaveCount(0);

      await pickProject(app, window, other.projectJson);
      await expect(window.locator('.ideas-canvas__card', { hasText: 'Febvre' })).toBeVisible({ timeout: 15_000 });
      await expect(window.locator('[role="alertdialog"]')).toHaveCount(0);
    });
    expect(readFileSync(project.ideasJson).equals(content)).toBe(true);
  } finally {
    chmodSync(join(project.dir, '.cliodeck'), 0o755);
    chmodSync(project.ideasJson, 0o644);
    rmSync(project.dir, { recursive: true, force: true });
    rmSync(other.dir, { recursive: true, force: true });
  }
});

test('des idées qui ne s’écrivent pas : la question les nomme, et l’auteur choisit de rester ou de partir', async () => {
  test.skip(process.getuid?.() === 0, 'root écrit partout');
  test.skip(process.platform === 'win32', 'chmod ne retire pas l’écriture sous Windows');
  const project = makeProject(ideasFile('Braudel'));
  const other = makeProject(ideasFile('Febvre'));
  chmodSync(project.ideasJson, 0o444);
  chmodSync(join(project.dir, '.cliodeck'), 0o555);
  const question = (window: Page) => window.locator('[role="alertdialog"]');
  try {
    await withApp(async (app, window) => {
      await openProject(app, window, project.projectJson);
      await goToTab(window, 'Idées');
      await window.locator('button[title="Nouvelle idée"]').first().click();
      await expect(banner(window)).toContainText('pas pu être enregistrées', { timeout: 10_000 });

      await pickProject(app, window, other.projectJson);
      await expect(question(window)).toContainText('fichier des idées', { timeout: 10_000 });

      // Rester : la liste et le message n'ont pas bougé.
      await question(window).locator('.confirm-dialog-btn-cancel').click();
      await expect(window.locator('.ideas-panel__item')).toHaveCount(2);
      await expect(banner(window)).toBeVisible();

      await window.locator('button[title="Ouvrir un projet"]').first().click();
      await question(window).locator('.confirm-dialog-btn-confirm').click();
      await expect(window.locator('.ideas-panel__item', { hasText: 'Febvre' })).toBeVisible({ timeout: 15_000 });
      await expect(banner(window)).toHaveCount(0);
    });
    // Sortir ensuite n'a rien redemandé : `withApp` ferme l'app sans qu'aucune écriture ne manque.
    expect(JSON.parse(readFileSync(project.ideasJson, 'utf8')).ideas).toHaveLength(1);
  } finally {
    chmodSync(join(project.dir, '.cliodeck'), 0o755);
    chmodSync(project.ideasJson, 0o644);
    rmSync(project.dir, { recursive: true, force: true });
    rmSync(other.dir, { recursive: true, force: true });
  }
});

test('pendant que le main bascule, le champ d’idée n’est plus à l’écran : rien n’y serait écrit', async () => {
  const project = makeProject(ideasFile('Braudel'));
  const other = makeProject(ideasFile('Febvre'));
  try {
    await withApp(async (app, window) => {
      await openProject(app, window, project.projectJson);
      await goToTab(window, 'Idées');
      await window.locator('.ideas-panel__item', { hasText: 'Braudel' }).click();
      await window.locator('.idea-editor__content').click();
      await window.keyboard.type(' TAPE-AVANT-LA-BASCULE');

      await app.evaluate(({ ipcMain }) => {
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })
          ._invokeHandlers;
        const load = handlers.get('project:load') as (...args: unknown[]) => unknown;
        handlers.set('project:load', async (...args: unknown[]) => {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          return load(...args);
        });
      });
      await pickProject(app, window, other.projectJson);

      await expect(window.locator('.brainstorm-panel__ideas-loading')).toBeVisible();
      await expect(window.locator('.idea-editor__content')).toHaveCount(0);
      await expect.poll(() => readFileSync(project.ideasJson, 'utf8')).toContain('TAPE-AVANT-LA-BASCULE');
      await expect(window.locator('.ideas-panel__item', { hasText: 'Febvre' })).toBeVisible({ timeout: 15_000 });
    });
  } finally {
    rmSync(project.dir, { recursive: true, force: true });
    rmSync(other.dir, { recursive: true, force: true });
  }
});

test('un fichier sain précédé d’un BOM se charge, et reste où il est', async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ideasFile('Braudel'))]);
  const project = makeProject(bytes);
  try {
    await withApp(async (app, window) => {
      await openProject(app, window, project.projectJson);
      await goToTab(window, 'Idées');

      await expect(window.locator('.ideas-panel__item', { hasText: 'Braudel' })).toBeVisible({ timeout: 10_000 });
      await expect(banner(window)).toHaveCount(0);
      expect(backups(project)).toEqual([]);
      expect(readFileSync(project.ideasJson).equals(bytes)).toBe(true);
    });
  } finally {
    rmSync(project.dir, { recursive: true, force: true });
  }
});

test('lecture impossible : rien ne bouge, Idées et Tableau sont fermés, et Réessayer suffit', async () => {
  test.skip(process.getuid?.() === 0, 'root lit tout');
  test.skip(process.platform === 'win32', 'chmod ne retire pas la lecture sous Windows');
  const content = ideasFile('Braudel');
  const project = makeProject(content);
  chmodSync(project.ideasJson, 0o000);
  try {
    await withApp(async (app, window) => {
      await openProject(app, window, project.projectJson);
      await goToTab(window, 'Idées');

      await expect(banner(window)).toBeVisible({ timeout: 10_000 });
      await expect(banner(window)).toContainText('ni déplacé ni modifié');
      await expect(window.locator('.ideas-panel')).toHaveCount(0);
      await goToTab(window, 'Tableau');
      await expect(window.locator('.ideas-canvas')).toHaveCount(0);
      expect(backups(project)).toEqual([]);

      chmodSync(project.ideasJson, 0o644);
      await window.locator('.brainstorm-panel__ideas-notice-retry').click();
      await expect(window.locator('.ideas-canvas__card', { hasText: 'Braudel' })).toBeVisible({ timeout: 10_000 });
      await expect(banner(window)).toHaveCount(0);
    });
    expect(JSON.parse(readFileSync(project.ideasJson, 'utf8')).ideas[0].title).toBe('Braudel');
  } finally {
    chmodSync(project.ideasJson, 0o644);
    rmSync(project.dir, { recursive: true, force: true });
  }
});

for (const geste of ['Cmd+Q', 'la croix'] as const) {
  test(`une idée tapée juste avant ${geste} est sur le disque`, async () => {
    const project = makeProject(ideasFile('Braudel'));
    const typed = ' FRAPPE-SANS-BLUR';
    try {
      await withApp(async (app, window) => {
        await openProject(app, window, project.projectJson);
        await goToTab(window, 'Idées');
        await window.locator('.ideas-panel__item', { hasText: 'Braudel' }).click();
        await window.locator('.idea-editor__content').click();
        await window.keyboard.press('ControlOrMeta+End');
        await window.keyboard.type(typed);

        const closed = app.waitForEvent('close').catch(() => undefined);
        await app.evaluate(({ app: electronApp, BrowserWindow }, what) => {
          if (what === 'Cmd+Q') electronApp.quit();
          else BrowserWindow.getAllWindows()[0].close();
        }, geste);
        // Sous macOS, la croix laisse l'app ouverte : on regarde le fichier, pas le processus.
        await Promise.race([closed, expect.poll(() => readFileSync(project.ideasJson, 'utf8')).toContain(typed)]);
      });
      expect(JSON.parse(readFileSync(project.ideasJson, 'utf8')).ideas[0].content).toContain(typed);
    } finally {
      rmSync(project.dir, { recursive: true, force: true });
    }
  });
}
