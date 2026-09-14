/**
 * Déclencheur d'indexation des notes de lecture, partagé par les points où
 * une note peut changer : ouverture du projet (une note éditée dans Obsidian
 * entre deux sessions), sauvegarde dans l'éditeur, étiquettes posées depuis
 * la bibliographie, clé de citation refaite par la synchronisation Zotero.
 *
 * Séparé de `reading-notes-index-service` pour ne pas y importer
 * `retrievalService`, qui importe déjà le service : l'indexation doit
 * embarquer avec le fournisseur de la recherche, sinon les cosinus
 * comparent deux espaces vectoriels.
 */

import { projectManager } from './project-manager.js';
import { retrievalService } from './retrieval-service.js';
import { readingNotesIndexService } from './reading-notes-index-service.js';

/** Lance une passe en fond. Best-effort : ne jette jamais, ne se fait pas attendre. */
export function indexReadingNotesInBackground(reason: string): void {
  void (async () => {
    try {
      if (!readingNotesIndexService.isEnabled()) return;
      const root = projectManager.getCurrentProjectPath();
      if (!root) return;
      const embedder = retrievalService.getEmbeddingProvider();
      if (!embedder) return;
      readingNotesIndexService.configure(root);
      const report = await readingNotesIndexService.index(embedder);
      if (report.indexed > 0 || report.removed > 0 || report.failures.length > 0) {
        console.log(
          `📚 Notes de lecture indexées (${reason}) : +${report.indexed} −${report.removed}, ${report.failures.length} échec(s)`
        );
      }
    } catch (error: unknown) {
      console.warn(`⚠️ Indexation des notes de lecture ignorée (${reason}):`, error);
    }
  })();
}
