/**
 * Sources primaires : après un changement de modèle d'embeddings, la réindexation est proposée,
 * jamais faite d'office (L06-9 : J7, Q29). Dans la vraie app : vrai preload derrière le vrai
 * `contextBridge`, vrais handlers, vrais services, vrai .tpy écrit par `makeTpy`, dossiers
 * temporaires uniquement. Le modèle d'embeddings est celui d'un faux Ollama à deux modèles : 768
 * dimensions, puis 1024 (`OTHER_EMBEDDING_MODEL`).
 *
 * Avant, les extraits calculés par l'ancien modèle restaient à leur dimension : la recherche des
 * archives levait, et le seul remède était la purge, qui efface aussi les transcriptions. Une base
 * aux extraits d'avant la version courante (H7) était même réembarquée d'office à l'ouverture,
 * tout le corpus envoyé au fournisseur sans geste de l'historien. Jugé sur les requêtes reçues par
 * le faux Ollama et sur les lignes du brain.db.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { launchApp } from './_helpers/launch';
import { startFakeOllama, OTHER_EMBEDDING_MODEL, type FakeOllama } from './_helpers/fake-ollama';
import { makeTpy } from '../backend/integrations/tropy/__tests__/helpers/make-tpy';

const roots: string[] = [];

test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SYLLABLES = ['ba', 'cor', 'di', 'fu', 'gal', 'le', 'mi', 'nor', 'pa', 'ru', 'sel', 'to', 'van', 'ze', 'qui', 'ran'];
function word(n: number): string {
  let s = '';
  for (let k = 0, x = n; k < 4; k++, x = Math.floor(x / SYLLABLES.length)) s += SYLLABLES[x % SYLLABLES.length];
  return s;
}
/** Une note Tropy de 500 caractères ou plus, aux mots distincts : la transcription de la source (Q26). */
function noteOf(offset: number): string {
  return Array.from({ length: 12 }, (_, i) =>
    `${Array.from({ length: 10 }, (_, k) => word(offset + 10 * i + k)).join(' ')}.`
  ).join(' ');
}

/** Les mots des deux notes : un texte qui en contient un vient des archives. */
const ARCHIVE_WORDS = new Set([...noteOf(0).split(/\W+/), ...noteOf(500).split(/\W+/)].filter((w) => w.length > 0));

/**
 * Les textes des archives envoyés au modèle d'embeddings. L'ouverture d'un projet en envoie
 * d'autres, les termes du dictionnaire de la recherche (préchauffage, J11) : ils ne comptent pas.
 */
function archiveTexts(ollama: FakeOllama, model: string): string[] {
  return ollama.embeddedTexts(model).filter((text) => text.split(/\W+/).some((w) => ARCHIVE_WORDS.has(w)));
}

function makeLayout(): { project: string; tpy: string } {
  const root = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-model-change-'));
  roots.push(root);
  const project = join(root, 'Thèse');
  mkdirSync(project);
  writeFileSync(
    join(project, 'project.json'),
    JSON.stringify({
      id: '00000000-0000-4000-8000-0000000000d9',
      name: 'Thèse',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(project, 'document.md'), '# Thèse\n');
  const tropyDir = join(root, 'tropy');
  mkdirSync(tropyDir);
  const tpy = makeTpy(tropyDir, {
    projectId: 'tropy-greves',
    name: 'Grèves nantaises',
    items: [
      { id: 10, title: 'Rapport du commissaire central', notes: [{ text: noteOf(0) }] },
      { id: 20, title: 'Lettre du syndicat des dockers', notes: [{ text: noteOf(500) }] },
    ],
  });
  return { project, tpy };
}

const brainDb = (projectDir: string) => join(projectDir, '.cliodeck', 'brain.db');

/** Les dimensions des vecteurs des archives, et leur nombre d'extraits. */
function chunks(projectDir: string): { dimensions: number[]; count: number } {
  const db = new Database(brainDb(projectDir), { readonly: true });
  try {
    const dimensions = (
      db.prepare('SELECT DISTINCT length(embedding) / 4 AS d FROM tropy_chunks ORDER BY d').all() as Array<{ d: number }>
    ).map((r) => r.d);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM tropy_chunks').get() as { n: number }).n;
    return { dimensions, count };
  } finally {
    db.close();
  }
}

/** Ce que l'historien a dans la base : sources, transcriptions, notes. */
function historianRows(projectDir: string): unknown {
  const db = new Database(brainDb(projectDir), { readonly: true });
  try {
    return db
      .prepare('SELECT id, title, transcription, transcription_source, notes_text FROM tropy_sources ORDER BY id')
      .all();
  } finally {
    db.close();
  }
}

/** La base telle qu'une version d'avant H7 l'a laissée : sans version d'extraits. L'app doit être fermée. */
function makeBaseFromBefore(projectDir: string): void {
  const db = new Database(brainDb(projectDir));
  try {
    db.exec('ALTER TABLE tropy_sources DROP COLUMN chunks_version');
  } finally {
    db.close();
  }
}

async function answerOpenDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, filePath);
}

async function openProject(app: ElectronApplication, window: Page, projectDir: string): Promise<void> {
  await window.locator('#left-tab-projects').click();
  await answerOpenDialog(app, join(projectDir, 'project.json'));
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Thèse', { timeout: 20_000 });
  await window.locator('#left-tab-primary-sources').click();
}

const panel = (window: Page) => window.locator('.primary-sources-panel');
const TITLE = 'Sources primaires à réindexer pour le nouveau modèle de recherche sémantique';
const proposal = (window: Page) => panel(window).locator('.tropy-reembed-notice');

test.describe('Sources primaires : un changement de modèle d’embeddings', () => {
  test('la réindexation est proposée, rien n’est réembarqué sans geste, même à la réouverture ; confirmée, elle refait les extraits et garde les transcriptions', async () => {
    test.setTimeout(240_000);
    const layout = makeLayout();
    const ollama: FakeOllama = await startFakeOllama('Réponse du faux modèle.');
    const { userDataDir } = ollama;
    try {
      // Première session : le projet Tropy lié et synchronisé avec le modèle d'avant, en 768.
      const first = await launchApp({ userDataDir });
      if (first.kind === 'skip') {
        test.skip(true, first.reason);
        return;
      }
      {
        const { app, window } = first.value;
        try {
          await openProject(app, window, layout.project);
          await answerOpenDialog(app, layout.tpy);
          await panel(window).locator('button[title="Ouvrir un projet Tropy"]').click();
          await expect(panel(window).locator('.project-name')).toHaveText('Grèves nantaises', { timeout: 20_000 });
          await panel(window).locator('button[title="Synchroniser"]').click();
          await expect.poll(() => chunks(layout.project).count, { timeout: 30_000 }).toBeGreaterThan(1);
          expect(chunks(layout.project).dimensions).toEqual([768]);
          // Témoin du filtre : les archives sont parties au modèle d'avant.
          expect(archiveTexts(ollama, 'faux-embed').length).toBeGreaterThan(0);
          await expect(proposal(window)).toHaveCount(0);

          // Le modèle d'embeddings change dans les Paramètres : le vrai `config:set`, qui refait les
          // fournisseurs de tous les services.
          await window.evaluate(async (model) => {
            const llm = await window.electron.config.get('llm');
            await window.electron.config.set('llm', { ...llm, ollamaEmbeddingModel: model });
          }, OTHER_EMBEDDING_MODEL);

          await expect(proposal(window)).toContainText(TITLE, { timeout: 20_000 });
          await expect(proposal(window)).toContainText('2 source(s) primaire(s)');
          await expect(proposal(window)).toContainText('768 dimensions');
          await expect(proposal(window)).toContainText('Les transcriptions sont gardées');
          await expect(window.locator('.status-bar').getByRole('button', { name: 'Sources primaires à réindexer' })).toBeVisible();
          expect(archiveTexts(ollama, OTHER_EMBEDDING_MODEL)).toEqual([]);
          expect(chunks(layout.project).dimensions).toEqual([768]);
        } finally {
          await app.close().catch(() => undefined);
        }
      }

      // Une base d'avant la version courante des extraits (H7) : la passe d'ouverture les
      // réembarquait d'office, au nouveau modèle.
      makeBaseFromBefore(layout.project);
      const rowsBefore = historianRows(layout.project);

      const second = await launchApp({ userDataDir });
      if (second.kind === 'skip') {
        test.skip(true, second.reason);
        return;
      }
      const { app, window } = second.value;
      try {
        await openProject(app, window, layout.project);
        await expect(proposal(window)).toContainText(TITLE, { timeout: 20_000 });
        // Rien sans geste : ni requête au nouveau modèle, ni extrait réécrit.
        expect(archiveTexts(ollama, OTHER_EMBEDDING_MODEL)).toEqual([]);
        expect(chunks(layout.project).dimensions).toEqual([768]);
        await expect(window.locator('.status-bar')).not.toContainText('Réindexation');

        // « Réindexer », puis la confirmation : ce que la passe coûte et ce qu'elle garde.
        await proposal(window).getByRole('button', { name: 'Réindexer' }).click();
        const question = window.locator('.confirm-dialog');
        await expect(question).toContainText('Les transcriptions sont gardées');
        await expect(question).toContainText('proposée de nouveau à la prochaine ouverture');
        await expect(question.locator('.confirm-dialog-btn-confirm')).not.toHaveClass(/\bis-danger\b/);
        await question.locator('.confirm-dialog-btn-confirm').click();

        await expect
          .poll(() => chunks(layout.project).dimensions, { timeout: 60_000 })
          .toEqual([1024]);
        await expect(panel(window)).toContainText(
          'Réindexation des sources primaires pour le nouveau modèle de recherche sémantique terminée : 2 source(s)',
          { timeout: 30_000 },
        );
        await expect(proposal(window)).toHaveCount(0);
        expect(archiveTexts(ollama, OTHER_EMBEDDING_MODEL).length).toBeGreaterThan(0);
        expect(historianRows(layout.project)).toEqual(rowsBefore);
      } finally {
        await app.close().catch(() => undefined);
      }
    } finally {
      await ollama.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
