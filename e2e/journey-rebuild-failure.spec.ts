/**
 * Une reconstruction des index en échec : l'historien voit la cause, ferme le message
 * et continue d'écrire.
 *
 * Le voile n'avait ni bouton ni Échap, et un échec le laissait pour de bon : la seule
 * sortie était le menu natif, et « Recharger » perdait le texte non enregistré. Les
 * événements passent ici par le vrai `contextBridge`, et le dernier parcours fait échouer
 * une vraie reconstruction sur un vrai disque, pendant l'ouverture du projet.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchApp } from './_helpers/launch';

const ARTICLE = '# Article\n\nTexte déjà enregistré.\n';
const CAUSE = 'Failed to save HNSW index: EISDIR';

const RUNNING = { current: 20, total: 100, status: 'Building HNSW index…', percentage: 20, phase: 'running' };
const DONE = { current: 100, total: 100, status: 'Rebuild complete', percentage: 100, phase: 'done' };
const FAILED = {
  current: 90,
  total: 100,
  status: `Error: ${CAUSE}`,
  percentage: 90,
  phase: 'failed',
  error: CAUSE,
};

interface Article {
  dir: string;
  projectJson: string;
  document: string;
}

function makeArticle(): Article {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-reconstruction-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000021',
      name: 'Projet E2E',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const document = join(dir, 'document.md');
  writeFileSync(document, ARTICLE);
  return { dir, projectJson, document };
}

/**
 * Un corpus déjà indexé dans brain.db, sans index HNSW : l'ouverture devra reconstruire.
 * Par le Node d'Electron : better-sqlite3 est compilé pour lui, pas pour Playwright.
 */
function seedChunks(projectDir: string): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const vectorStore = pathToFileURL(join(repoRoot, 'dist/backend/core/vector-store/VectorStore.js')).href;
  const script = `
    const [projectDir, modulePath] = process.argv.slice(1);
    import(modulePath).then(({ VectorStore }) => {
      const store = new VectorStore(projectDir);
      const now = new Date();
      store.saveDocument({
        id: 'doc1', fileURL: projectDir + '/a.pdf', title: 'A', pageCount: 3, metadata: {},
        createdAt: now, indexedAt: now, lastAccessedAt: now,
      });
      for (let i = 0; i < 30; i += 1) {
        const embedding = new Float32Array(768).map((_, j) => Math.sin(i * 7 + j));
        store.saveChunk({
          id: 'c' + i, documentId: 'doc1', content: 'Extrait ' + i + ' sur les archives.',
          pageNumber: 1, chunkIndex: i, startPosition: 0, endPosition: 10,
        }, embedding);
      }
      store.close();
    });
  `;
  const electronPath = createRequire(import.meta.url)('electron') as string;
  execFileSync(electronPath, ['-e', script, projectDir, vectorStore], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'pipe',
  });
}

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
}

/** Comme le main : sur le canal réel, à destination de la fenêtre. */
const sendProgress = (app: ElectronApplication, event: Record<string, unknown>) =>
  app.evaluate(({ BrowserWindow }, progress) => {
    BrowserWindow.getAllWindows()[0].webContents.send('project:rebuild-progress', progress);
  }, event);

const sendMenu = (app: ElectronApplication, channel: string) =>
  app.evaluate(({ BrowserWindow }, c) => {
    BrowserWindow.getAllWindows()[0].webContents.send(c);
  }, channel);

const editor = (window: Page) => window.locator('.codemirror-editor .cm-content');
const veil = (window: Page) => window.locator('.rebuild-modal');
const closeButton = (window: Page) => veil(window).getByRole('button', { name: 'Fermer' });

async function typeAtEnd(window: Page, text: string): Promise<void> {
  await editor(window).click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type(text);
}

/** Le projet ouvert, dans une app lancée pour ce test, puis tout rangé. */
async function withOpenArticle(
  run: (app: ElectronApplication, window: Page, article: Article) => Promise<void>,
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
    await expect(editor(window)).toContainText('Texte déjà enregistré', { timeout: 20_000 });
    await run(app, window, article);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(article.dir, { recursive: true, force: true });
  }
}

test('échec : le message dit la cause, Fermer le retire, et le panneau répond au clic', async () => {
  await withOpenArticle(async (app, window) => {
    await sendProgress(app, RUNNING);
    await expect(veil(window)).toBeVisible();

    await sendProgress(app, FAILED);

    const dialog = window.getByRole('alertdialog');
    await expect(dialog).toContainText('n\'ont pas pu être reconstruits');
    await expect(dialog).toContainText('vous pouvez continuer à écrire');
    await expect(dialog).toContainText(CAUSE);
    await expect(closeButton(window)).toBeFocused();

    await closeButton(window).click();

    await expect(veil(window)).toHaveCount(0);
    const bibliography = window.locator('#left-tab-bibliography');
    await bibliography.click();
    await expect(bibliography).toHaveAttribute('aria-selected', 'true');
  });
});

test('échec en pleine frappe : Échap rend le focus à l’éditeur, et la suite s’écrit sur le disque', async () => {
  await withOpenArticle(async (app, window, article) => {
    await typeAtEnd(window, 'Avant. ');

    await sendProgress(app, FAILED);
    await expect(closeButton(window)).toBeFocused();

    await window.keyboard.press('Escape');

    await expect(veil(window)).toHaveCount(0);
    await expect(editor(window)).toBeFocused();
    // Sans clic : c'est là que l'auteur en était.
    await window.keyboard.type('Après.');
    await expect
      .poll(() => readFileSync(article.document, 'utf8'), { timeout: 15_000 })
      .toBe(`${ARTICLE}Avant. Après.`);
  });
});

test('pendant la reconstruction, rien de fermable ; un succès retire le voile', async () => {
  await withOpenArticle(async (app, window) => {
    await sendProgress(app, RUNNING);
    await expect(veil(window)).toBeVisible();
    await expect(veil(window).locator('button, [href], input, select, textarea, [tabindex]')).toHaveCount(0);

    await window.keyboard.press('Escape');
    await expect(veil(window)).toBeVisible();

    await sendProgress(app, DONE);
    await expect(veil(window)).toHaveCount(0);
  });
});

test('un dialogue de la file sur le message : aucun ne bloque l’autre, et la frappe reprend', async () => {
  await withOpenArticle(async (app, window, article) => {
    await typeAtEnd(window, 'Avant. ');
    await sendProgress(app, FAILED);
    await expect(closeButton(window)).toBeFocused();

    await sendMenu(app, 'menu:new-file');
    const cancel = window.locator('.confirm-dialog .confirm-dialog-btn-cancel');
    await expect(cancel).toBeFocused();

    // Échap répond au dialogue du dessus, et lui seul : le message n'est pas encore lu.
    await window.keyboard.press('Escape');
    await expect(window.locator('.confirm-dialog')).toHaveCount(0);
    await expect(veil(window)).toBeVisible();
    await expect(closeButton(window)).toBeFocused();

    await closeButton(window).click();
    await expect(veil(window)).toHaveCount(0);
    await expect(editor(window)).toBeFocused();

    await window.keyboard.type('Après.');
    await expect
      .poll(() => readFileSync(article.document, 'utf8'), { timeout: 15_000 })
      .toBe(`${ARTICLE}Avant. Après.`);
  });
});

test('onRebuildProgress rend de quoi se désabonner, à travers le contextBridge', async () => {
  await withOpenArticle(async (app, window) => {
    interface Probe {
      electron: { project: { onRebuildProgress: (listener: () => void) => unknown } };
      removed: number;
      witness: number;
      unsubscribe: () => void;
    }

    const kind = await window.evaluate(() => {
      const probe = window as unknown as Probe;
      probe.removed = 0;
      probe.witness = 0;
      probe.electron.project.onRebuildProgress(() => {
        probe.witness += 1;
      });
      const unsubscribe = probe.electron.project.onRebuildProgress(() => {
        probe.removed += 1;
      });
      probe.unsubscribe = unsubscribe as () => void;
      return typeof unsubscribe;
    });
    expect(kind).toBe('function');

    await sendProgress(app, DONE);
    await expect.poll(() => window.evaluate(() => (window as unknown as Probe).removed)).toBe(1);

    await window.evaluate(() => (window as unknown as Probe).unsubscribe());
    await sendProgress(app, DONE);

    // Le témoin, resté abonné, dit que l'événement est bien arrivé.
    await expect.poll(() => window.evaluate(() => (window as unknown as Probe).witness)).toBe(2);
    expect(await window.evaluate(() => (window as unknown as Probe).removed)).toBe(1);
  });
});

test('vraie reconstruction en échec à l’ouverture : le chargement se termine, le message se ferme, on écrit', async () => {
  test.setTimeout(120_000);
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const article = makeArticle();
  seedChunks(article.dir);
  const blocker = join(article.dir, '.cliodeck', 'hnsw.index.meta.json.tmp');
  mkdirSync(blocker);

  try {
    await openProject(app, window, article.projectJson);

    await expect(veil(window)).toContainText('Failed to save HNSW index', { timeout: 60_000 });
    // Le voile n'arrête pas l'ouverture : le document arrive derrière lui.
    await expect(editor(window)).toContainText('Texte déjà enregistré', { timeout: 30_000 });

    // La reconstruction repart une fois après le préchauffage du modèle d'embeddings, et
    // ce moment dépend du poste : un message peut suivre celui qu'on vient de fermer. On
    // recommence jusqu'à ce que la frappe atteigne le disque.
    await expect(async () => {
      const close = closeButton(window);
      if (await close.isVisible()) await close.click({ timeout: 2_000 });
      await editor(window).click({ timeout: 2_000 });
      await window.keyboard.press('ControlOrMeta+End');
      await window.keyboard.type('Écrit après l’échec.');
      await expect
        .poll(() => readFileSync(article.document, 'utf8'), { timeout: 8_000 })
        .toContain('Écrit après l’échec.');
    }).toPass({ timeout: 90_000 });

    expect(readFileSync(article.document, 'utf8').startsWith(ARTICLE)).toBe(true);
    // Le blocage est toujours là, et aucun index n'a pu s'écrire : c'est bien cet échec.
    expect(existsSync(blocker)).toBe(true);
    expect(existsSync(join(article.dir, '.cliodeck', 'hnsw.index'))).toBe(false);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(article.dir, { recursive: true, force: true });
  }
});
