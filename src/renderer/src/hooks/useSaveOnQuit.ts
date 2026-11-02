/**
 * Sauvegarde le document ouvert quand l'application se ferme.
 *
 * `before-quit` arrêtait les services mais pas l'éditeur, et aucun
 * `beforeunload` n'existait : `Cmd+Q` dans les trois secondes suivant une
 * frappe perdait le texte — et sans autosave, la perte n'était pas bornée.
 *
 * Deux précautions :
 *  - on compare le texte VIVANT au miroir du store, pas seulement `isDirty` :
 *    la synchronisation CM6 → store est debouncée, donc `isDirty` peut être
 *    encore faux alors que l'auteur vient de taper. C'est précisément la
 *    fenêtre qui perdait des données ;
 *  - l'accusé part dans tous les cas, y compris en cas d'échec d'écriture.
 *    Le main borne déjà son attente ; ne pas répondre ne ferait qu'ajouter
 *    un délai à une fermeture déjà demandée.
 */
import { useEffect } from 'react';
import { needsFlush, useEditorStore } from '../stores/editorStore';
import { logger } from '../utils/logger';

export { needsFlush };

export function useSaveOnQuit(): void {
  useEffect(() => {
    const api = window.electron?.lifecycle;
    if (!api) return;

    const unsubscribe = api.onFlushBeforeQuit(() => {
      void (async () => {
        try {
          const state = useEditorStore.getState();
          const shouldSave = needsFlush({
            filePath: state.filePath,
            isDirty: state.isDirty,
            live: state.getLiveContent(),
            mirror: state.content,
          });

          if (shouldSave) {
            logger.store('SaveOnQuit', 'Sauvegarde avant fermeture', {
              filePath: state.filePath,
            });
            await state.saveFile();
          }
        } catch (error) {
          logger.error('SaveOnQuit', error);
        } finally {
          api.flushDone();
        }
      })();
    });

    return unsubscribe;
  }, []);
}
