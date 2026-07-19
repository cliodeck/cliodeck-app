/**
 * Handlers du corpus « manuscrit » (item 25 des audits).
 *
 * Deux canaux seulement, en lecture/déclenchement : indexer le manuscrit
 * du projet courant, et lire l'état de l'index. Aucun payload venant du
 * renderer n'atteint le disque — le service travaille sur le projet
 * courant résolu côté main, et le validateur de chemins n'a donc rien à
 * arbitrer ici.
 *
 * L'indexation est best-effort : ces handlers ne propagent jamais un
 * échec d'embedding comme une erreur d'application. Ils renvoient le
 * rapport, l'appelant décide quoi en montrer.
 */

import { ipcMain } from 'electron';
import { manuscriptIndexService } from '../../services/manuscript-index-service.js';
import { projectManager } from '../../services/project-manager.js';
import { retrievalService } from '../../services/retrieval-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';

export function setupManuscriptHandlers(): void {
  /**
   * Indexe (incrémentalement) le manuscrit du projet courant. Ne réembarque
   * que les chapitres dont l'empreinte a changé.
   */
  ipcMain.handle('manuscript:index', async () => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return errorResponse('no_project');

    const embedder = retrievalService.getEmbeddingProvider();
    if (!embedder) {
      // Provider indisponible (Ollama éteint, config incomplète) : ce n'est
      // pas une erreur d'application, l'index reste simplement en l'état.
      return successResponse({
        report: null,
        reason: 'embedding_provider_unavailable',
      });
    }

    manuscriptIndexService.configure(root);
    const report = await manuscriptIndexService.index(embedder);
    return successResponse({ report });
  });

  /** État de l'index : nombre de chapitres et de chunks. */
  ipcMain.handle('manuscript:stats', async () => {
    const root = projectManager.getCurrentProjectPath();
    if (!root) return errorResponse('no_project');
    manuscriptIndexService.configure(root);
    return successResponse({ stats: manuscriptIndexService.stats() });
  });

  console.log('✅ Manuscript handlers registered');
}
