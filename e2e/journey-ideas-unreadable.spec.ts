/**
 * Un `ideas.json` abîmé ou inaccessible, dans la vraie app : le preload, les vrais handlers, le
 * vrai disque. Avant, le fichier était pris pour une liste vide, et la première action
 * l'écrasait : 40 idées perdues pour une seule créée (S15-1-2).
 *
 * Et une idée tapée juste avant de quitter : seul le blur d'un champ l'écrivait, et ni `Cmd+Q`
 * ni la croix n'en font un.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
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
