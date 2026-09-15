/**
 * Handlers du corpus « notes de lecture ».
 *
 * Trois canaux, en lecture ou déclenchement, sur le projet courant résolu
 * côté main : aucun payload du renderer n'atteint le disque. Comme pour le
 * manuscrit, un fournisseur d'embeddings absent n'est pas une erreur
 * d'application : l'index reste en l'état et la réponse le dit.
 */

import { ipcMain } from 'electron';
import { readingNotesIndexService } from '../../services/reading-notes-index-service.js';
import { projectManager } from '../../services/project-manager.js';
import { retrievalService } from '../../services/retrieval-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';

export function setupReadingNotesCorpusHandlers(): void {
  const run = async (all: boolean) => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return errorResponse('no_project');
    const embedder = retrievalService.getEmbeddingProvider();
    if (!embedder) {
      return successResponse({ report: null, reason: 'embedding_provider_unavailable' });
    }
    readingNotesIndexService.configure(root);
    const report = all
      ? await readingNotesIndexService.reindexAll(embedder)
      : await readingNotesIndexService.index(embedder);
    return successResponse({ report });
  };

  ipcMain.handle('reading-notes-corpus:index', () => run(false));

  /** Empreintes ignorées : après un changement de modèle d'embedding. */
  ipcMain.handle('reading-notes-corpus:reindex-all', () => run(true));

  ipcMain.handle('reading-notes-corpus:stats', async () => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return errorResponse('no_project');
    readingNotesIndexService.configure(root);
    return successResponse({ stats: readingNotesIndexService.stats() });
  });

  console.log('✅ Reading notes corpus handlers registered');
}
