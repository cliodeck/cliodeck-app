/**
 * Sources primaires : une transcription écrite Ollama arrêté (L06-7). Dans la vraie app : vrai
 * preload derrière le vrai `contextBridge`, vrais handlers, vrais services, vrai .tpy écrit par
 * `makeTpy`, dossiers temporaires uniquement.
 *
 * Avant, l'import d'un fichier se disait « Transcription importée. » alors que la source sortait du
 * RAG (aucun extrait recréé), et l'étiquetait « transkribus » quel qu'en soit le format ; un OCR
 * manuel s'enregistrait « manual », sans sa confiance, qui ne passait pas le preload. « Ollama
 * arrêté » : un faux Ollama dont le port est fermé, puis rouvert. Jugé sur les lignes du brain.db.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { launchApp } from './_helpers/launch';
import { startFakeOllama, type FakeOllama } from './_helpers/fake-ollama';
import { makeTpy } from '../backend/integrations/tropy/__tests__/helpers/make-tpy';

const roots: string[] = [];

test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const IMPORTED_TEXT =
  'Le commissaire central rend compte au préfet de la réunion tenue salle Colbert le 18 mars 1907. ' +
  'Près de huit cents dockers et charretiers y ont voté la grève générale du port de Nantes.';

// Au moins vingt mots : en dessous, le filtre de qualité ne garde aucun extrait à embarquer.
const OCR_TEXT =
  'Texte reconnu par Tesseract : le commissaire signale que la réunion du mardi a rassemblé ' +
  'une majorité de dockers, et que deux agents en civil ont pris des notes pendant toute la séance.';

function makeLayout(): { project: string; tpy: string; transcription: string } {
  const root = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-transcription-'));
  roots.push(root);
  const project = join(root, 'Thèse');
  mkdirSync(project);
  writeFileSync(
    join(project, 'project.json'),
    JSON.stringify({
      id: '00000000-0000-4000-8000-0000000000c3',
      name: 'Thèse',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(project, 'document.md'), '# Thèse\n');
  const tropyDir = join(root, 'tropy');
  mkdirSync(tropyDir);
  const photo = join(tropyDir, 'rapport.jpg');
  writeFileSync(photo, 'jpeg factice');
  const tpy = makeTpy(tropyDir, {
    projectId: 'tropy-greves',
    name: 'Grèves nantaises',
    items: [{ id: 10, title: 'Rapport du commissaire central', photos: [{ id: 11, path: photo }] }],
  });
  const transcription = join(root, 'rapport.txt');
  writeFileSync(transcription, IMPORTED_TEXT);
  return { project, tpy, transcription };
}

interface SourceRow {
  id: string;
  transcription: string | null;
  transcription_source: string | null;
  ocr_confidence: number | null;
  chunks: number;
}

function sourceRow(projectDir: string): SourceRow {
  const db = new Database(join(projectDir, '.cliodeck', 'brain.db'), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT s.id, s.transcription, s.transcription_source, s.ocr_confidence,
                (SELECT COUNT(*) FROM tropy_chunks c WHERE c.source_id = s.id) AS chunks
         FROM tropy_sources s WHERE s.tropy_id = 10`,
      )
      .get() as SourceRow;
  } finally {
    db.close();
  }
}

async function answerOpenDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, filePath);
}

const panel = (window: Page) => window.locator('.primary-sources-panel');

test.describe('Sources primaires : une transcription écrite Ollama arrêté', () => {
  test('OCR manuel puis import : enregistrés avec leur provenance, « pas encore indexée » dit, repris à la synchro', async () => {
    test.setTimeout(180_000);
    const layout = makeLayout();

    // Un faux Ollama, aussitôt arrêté : l'app est réglée sur un port fermé.
    const first = await startFakeOllama('Réponse du faux modèle.');
    const { port, userDataDir } = first;
    await first.close();
    let ollama: FakeOllama | null = null;

    const outcome = await launchApp({ userDataDir });
    if (outcome.kind === 'skip') {
      rmSync(userDataDir, { recursive: true, force: true });
      test.skip(true, outcome.reason);
      return;
    }
    const { app, window } = outcome.value;
    try {
      // Le projet, puis son projet Tropy : une source, sans transcription.
      await window.locator('#left-tab-projects').click();
      await answerOpenDialog(app, join(layout.project, 'project.json'));
      await window.locator('button[title="Ouvrir un projet"]').first().click();
      await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Thèse', { timeout: 20_000 });
      await window.locator('#left-tab-primary-sources').click();
      await answerOpenDialog(app, layout.tpy);
      await panel(window).locator('button[title="Ouvrir un projet Tropy"]').click();
      await expect(panel(window).locator('.project-name')).toHaveText('Grèves nantaises', { timeout: 20_000 });
      const card = panel(window).locator('.primary-source-card', { hasText: 'Rapport du commissaire central' });
      await expect(card).toBeVisible({ timeout: 20_000 });

      // La source sélectionnée : son rapport OCR s'affiche sous la carte.
      await card.click();
      const report = panel(window).locator('.ocr-source-report');
      await expect(report).toContainText('Aucune donnée OCR');

      // OCR manuel depuis la carte. Seule la reconnaissance est simulée, côté main : Tesseract
      // téléchargerait ses données de langue. Carte, store, vrai preload, handler et brain.db
      // sont réels — la confiance passe le preload en 4e argument.
      await app.evaluate(({ ipcMain }, text) => {
        ipcMain.removeHandler('tropy:perform-batch-ocr');
        ipcMain.handle('tropy:perform-batch-ocr', async () => ({ success: true, text, confidence: 77.5 }));
      }, OCR_TEXT);
      await card.locator('button[title="Lancer l\'OCR sur cette source"]').click();
      const alert = window.locator('.alert-dialog');
      await expect(alert).toContainText('Transcription enregistrée, pas encore indexée', { timeout: 20_000 });
      await alert.locator('.alert-dialog-btn-ok').click();
      expect(sourceRow(layout.project)).toMatchObject({
        transcription: OCR_TEXT,
        transcription_source: 'tesseract',
        ocr_confidence: 77.5,
        chunks: 0,
      });
      // Le rapport se relit sans changer de source.
      await expect(report).toContainText('Tesseract (OCR)');
      await expect(report).toContainText('78%');

      // Import d'un texte brut pour la même source : pas « Transcription importée. ».
      await panel(window).locator('button[title="Importer une transcription"]').click();
      const modal = window.locator('.transcription-import-modal');
      await answerOpenDialog(app, layout.transcription);
      await modal.locator('.btn-primary').click();
      await expect(modal.locator('.import-result')).toContainText('Transcription enregistrée, pas encore indexée', {
        timeout: 20_000,
      });
      await expect(modal).not.toContainText('Transcription importée.');
      await expect(modal.locator('.import-result')).toHaveClass(/warning/);
      expect(sourceRow(layout.project)).toMatchObject({
        transcription: IMPORTED_TEXT,
        transcription_source: 'imported',
        ocr_confidence: null,
        chunks: 0,
      });
      await modal.locator('.close-button').click();

      // « Synchroniser », Ollama toujours arrêté : pas d'alerte, un avis dans le panneau.
      const sync = panel(window).locator('button[title="Synchroniser"]');
      await sync.click();
      const notice = panel(window).locator('.sync-notice');
      await expect(notice).toContainText('1 source(s) enregistrée(s), pas encore indexée(s)', { timeout: 30_000 });
      await expect(window.locator('[role="alertdialog"]')).toHaveCount(0);

      // Ollama relancé : la synchro suivante indexe la source et l'avis disparaît.
      ollama = await startFakeOllama('Réponse du faux modèle.', { port });
      rmSync(ollama.userDataDir, { recursive: true, force: true });
      await sync.click();
      await expect(notice).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(() => sourceRow(layout.project).chunks, { timeout: 30_000 }).toBeGreaterThan(0);
      // Indexée, la source garde sa provenance, nommée dans le rapport.
      await expect(report).toContainText('Fichier importé');
    } finally {
      await app.close().catch(() => undefined);
      await ollama?.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
