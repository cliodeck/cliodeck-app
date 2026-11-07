/**
 * Sources primaires : le projet B ne voit ni n'importe l'archive du projet A (S18-1-30), et la
 * purge laisse un panneau vide d'où un autre projet Tropy s'ouvre (S08-2-9). Dans la vraie app :
 * vrai preload derrière le vrai `contextBridge`, vrais handlers, vrais services, vrais .tpy écrits
 * par `makeTpy`, dossiers temporaires uniquement.
 *
 * Avant, le panneau de B, sans Tropy, gardait le projet Tropy de A et ses boutons ; l'œil envoyait
 * le chemin de A au main, qui l'adoptait, et « Synchroniser » importait l'archive de A dans le
 * brain.db de B — la garde d'identité de L06-3 n'y voit qu'une première liaison. Jugé sur les
 * lignes du brain.db de B.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { launchApp } from './_helpers/launch';
import { makeTpy } from '../backend/integrations/tropy/__tests__/helpers/make-tpy';

const roots: string[] = [];

test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Layout {
  projectA: string;
  projectB: string;
  danzig: string;
  comite: string;
}

function writeProject(dir: string, id: string, name: string): void {
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({
      id,
      name,
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'document.md'), `# ${name}\n`);
}

function makeLayout(): Layout {
  const root = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-tropy-'));
  roots.push(root);
  const projectA = join(root, 'Thèse');
  const projectB = join(root, 'Article');
  writeProject(projectA, '00000000-0000-4000-8000-0000000000a1', 'Thèse');
  writeProject(projectB, '00000000-0000-4000-8000-0000000000b2', 'Article');
  const tropyDir = join(root, 'tropy');
  mkdirSync(tropyDir);
  const photo = join(tropyDir, 'photo.jpg');
  writeFileSync(photo, 'jpeg factice');
  const danzig = makeTpy(tropyDir, {
    projectId: 'tropy-danzig',
    name: 'Archives Danzig',
    items: [
      { id: 10, title: 'Rapport du préfet', photos: [{ id: 11, path: photo }] },
      { id: 20, title: 'Lettre du commissaire', photos: [{ id: 21, path: photo }] },
    ],
  });
  const comite = makeTpy(tropyDir, {
    projectId: 'tropy-comite',
    name: 'Comité de grève',
    items: [{ id: 10, title: 'Procès-verbal de séance', photos: [{ id: 11, path: photo }] }],
  });
  return { projectA, projectB, danzig, comite };
}

/** Ce que le brain.db d'un projet tient de Tropy. */
function tropyRows(projectDir: string): { sources: number; projects: number } {
  const db = new Database(join(projectDir, '.cliodeck', 'brain.db'), { readonly: true });
  try {
    const sources = (db.prepare('SELECT COUNT(*) AS n FROM tropy_sources').get() as { n: number }).n;
    const projects = (db.prepare('SELECT COUNT(*) AS n FROM tropy_projects').get() as { n: number }).n;
    return { sources, projects };
  } finally {
    db.close();
  }
}

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

async function answerOpenDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, filePath);
}

/** Panneau Projet, « Ouvrir un projet » : l'éditeur montre le document du projet. */
async function openProject(app: ElectronApplication, window: Page, dir: string, title: string): Promise<void> {
  await window.locator('#left-tab-projects').click();
  await answerOpenDialog(app, join(dir, 'project.json'));
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText(title, { timeout: 20_000 });
}

const panel = (window: Page) => window.locator('.primary-sources-panel');
const syncButton = (window: Page) => panel(window).locator('button[title="Synchroniser"]');
const eyeButton = (window: Page) =>
  panel(window).locator('button[title="Activer la synchronisation automatique"]');

/** Panneau Sources primaires, puis l'icône dossier : le projet Tropy est lié et synchronisé. */
async function linkTropy(app: ElectronApplication, window: Page, tpy: string, name: string, firstTitle: string) {
  await window.locator('#left-tab-primary-sources').click();
  await answerOpenDialog(app, tpy);
  await panel(window).locator('button[title="Ouvrir un projet Tropy"]').click();
  await expect(panel(window).locator('.project-name')).toHaveText(name, { timeout: 20_000 });
  await expect(panel(window)).toContainText(firstTitle, { timeout: 20_000 });
}

test.describe('Sources primaires : un projet ClioDeck, son projet Tropy', () => {
  test('B sans Tropy, après A : panneau vide, rien de A dans le brain.db de B ; A retrouvé', async () => {
    test.setTimeout(150_000);
    const layout = makeLayout();

    await withApp(async (app, window) => {
      await openProject(app, window, layout.projectA, 'Thèse');
      await linkTropy(app, window, layout.danzig, 'Archives Danzig', 'Rapport du préfet');
      expect(tropyRows(layout.projectA)).toEqual({ sources: 2, projects: 1 });

      await openProject(app, window, layout.projectB, 'Article');
      await window.locator('#left-tab-primary-sources').click();
      await expect(panel(window).getByText(/Aucun projet Tropy|Archives Danzig/).first()).toBeVisible();

      // Le geste de la contre-vérification, sur ce que le panneau propose dans B.
      if ((await eyeButton(window).count()) > 0) await eyeButton(window).click();
      if ((await syncButton(window).count()) > 0) {
        await syncButton(window).click();
        await expect(syncButton(window)).not.toHaveClass(/syncing/, { timeout: 30_000 });
      }
      expect(tropyRows(layout.projectB)).toEqual({ sources: 0, projects: 0 });

      await expect(panel(window)).toContainText('Aucun projet Tropy');
      await expect(panel(window)).not.toContainText('Archives Danzig');
      await expect(syncButton(window)).toHaveCount(0);
      await expect(eyeButton(window)).toHaveCount(0);

      // Le vrai preload, sous le vrai `contextBridge` : un chemin passé à la surveillance n'arrive
      // pas au main, et le main ne suit que le projet lié — B n'en a pas.
      const outcome = await window.evaluate(async (tpy) => {
        const tropy = (window as unknown as {
          electron: { tropy: Record<string, (...args: unknown[]) => Promise<{ success: boolean }>> };
        }).electron.tropy;
        const watching = await tropy.startWatching(tpy);
        const sync = await tropy.sync({ performOCR: false, ocrLanguage: 'fra' });
        return { watching: watching.success, sync: sync.success };
      }, layout.danzig);
      expect(outcome).toEqual({ watching: false, sync: false });
      expect(tropyRows(layout.projectB)).toEqual({ sources: 0, projects: 0 });

      // Revenir au premier : tout réapparaît.
      await openProject(app, window, layout.projectA, 'Thèse');
      await window.locator('#left-tab-primary-sources').click();
      await expect(panel(window).locator('.project-name')).toHaveText('Archives Danzig', { timeout: 20_000 });
      await expect(panel(window)).toContainText('Lettre du commissaire');
      await expect(syncButton(window)).toHaveCount(1);
      expect(tropyRows(layout.projectA)).toEqual({ sources: 2, projects: 1 });
    });
  });

  test('B lié à Tropy en cours de session : la recherche survit à un changement d’onglet', async () => {
    test.setTimeout(150_000);
    const layout = makeLayout();

    await withApp(async (app, window) => {
      // B s'ouvre sans Tropy : son panneau est vide.
      await openProject(app, window, layout.projectB, 'Article');
      await window.locator('#left-tab-primary-sources').click();
      await expect(panel(window)).toContainText('Aucun projet Tropy');

      // L'historien y lie un projet Tropy, puis cherche dans ses sources.
      await linkTropy(app, window, layout.comite, 'Comité de grève', 'Procès-verbal de séance');
      const search = () => panel(window).getByPlaceholder('Rechercher dans les sources...');
      await search().fill('Procès');

      // Un autre onglet, puis retour : même projet, la recherche est toujours là. Avant, la
      // remise à zéro faite pour « pas de projet Tropy » effaçait aussi le projet auquel l'état
      // appartient, et le panneau, à son retour, croyait changer de projet.
      await window.locator('#left-tab-bibliography').click();
      await expect(panel(window)).toHaveCount(0);
      await window.locator('#left-tab-primary-sources').click();
      await expect(panel(window).locator('.project-name')).toHaveText('Comité de grève', { timeout: 20_000 });
      await expect(search()).toHaveValue('Procès');
      expect(tropyRows(layout.projectB)).toEqual({ sources: 1, projects: 1 });
    });
  });

  test('purge : panneau vide, sans « Synchroniser », puis un autre projet Tropy s’ouvre', async () => {
    test.setTimeout(150_000);
    const layout = makeLayout();

    await withApp(async (app, window) => {
      await openProject(app, window, layout.projectA, 'Thèse');
      await linkTropy(app, window, layout.danzig, 'Archives Danzig', 'Rapport du préfet');

      // Panneau Projet, section « Actions », « Purger Sources Primaires » : deux confirmations.
      await window.locator('#left-tab-projects').click();
      await window.locator('button.collapsible-header', { hasText: 'Actions' }).click();
      const purge = window.getByRole('button', { name: 'Purger Sources Primaires' });
      await expect(purge).toBeEnabled({ timeout: 10_000 });
      await purge.click();
      for (let i = 0; i < 2; i += 1) {
        await window.locator('.confirm-dialog-btn-confirm').click();
      }
      await expect(window.locator('#alert-dialog-message')).toContainText('purgée avec succès', { timeout: 10_000 });
      await window.locator('.alert-dialog-btn-ok').click();
      expect(tropyRows(layout.projectA)).toEqual({ sources: 0, projects: 0 });

      await window.locator('#left-tab-primary-sources').click();
      await expect(panel(window)).toContainText('Aucun projet Tropy');
      await expect(panel(window)).not.toContainText('Archives Danzig');
      await expect(panel(window)).not.toContainText('Rapport du préfet');
      await expect(syncButton(window)).toHaveCount(0);

      // Le chemin que donne le message de L06-3 pour changer de projet Tropy.
      await linkTropy(app, window, layout.comite, 'Comité de grève', 'Procès-verbal de séance');
      await expect(panel(window)).not.toContainText('Rapport du préfet');
      expect(tropyRows(layout.projectA)).toEqual({ sources: 1, projects: 1 });
    });
  });
});
