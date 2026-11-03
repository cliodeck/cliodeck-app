/**
 * Sauvegarde le document ouvert quand l'éditeur va être détruit : fermeture de la
 * fenêtre, sortie, rechargement.
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
 *  - l'accusé part dans tous les cas, y compris en cas d'échec d'écriture, et
 *    le rapport le dit : c'est sur lui que le main décide de demander à l'auteur.
 */
import { useEffect } from 'react';
import type { FlushReport } from '../../../../backend/types/flush-report';
import {
  needsFlush,
  useEditorStore,
  watchSaveOvertaken,
  writeOpenDocumentWhileDirty,
} from '../stores/editorStore';
import { logger } from '../utils/logger';

export { needsFlush };

/** Le main renonce à attendre à 4 s : il doit rester de quoi écrire le tampon. */
const SWITCH_LOCK_WAIT_MS = 2500;

/**
 * Une renumérotation écrit le manuscrit chapitre par chapitre, et le renderer détruit la
 * laisserait à mi-chemin : on la laisse finir, ou se défaire. Sans l'attendre davantage que
 * ce plafond : un disque très lent la perdrait de toute façon, le texte du tampon non.
 */
function switchLockReleased(): Promise<void> {
  return new Promise((resolve) => {
    if (!useEditorStore.getState().switchLock) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, SWITCH_LOCK_WAIT_MS);
    const unsubscribe = useEditorStore.subscribe((state) => {
      if (!state.switchLock) done();
    });
  });
}

/**
 * Écrit le document ouvert, et dit ce qu'il en est advenu. Ne rejette jamais.
 *
 * Après un plantage de rendu, la vue n'est plus là : le texte vivant est alors le miroir du
 * store, où le démontage de la vue a purgé la dernière frappe. Un tampon détaché par un
 * changement de projet n'a rien à perdre : le sortant est déjà écrit, ou abandonné avec
 * l'accord de l'auteur, et le changement n'a pas à lui reposer la question.
 */
export async function flushOpenDocument(): Promise<FlushReport> {
  await switchLockReleased();
  const state = useEditorStore.getState();
  if (state.bufferDetached) return { outcome: 'clean' };

  const overtaken = watchSaveOvertaken();
  try {
    const live = state.getLiveContent();
    if (!state.filePath) return { outcome: live === '' ? 'clean' : 'untitled' };
    if (!needsFlush({ filePath: state.filePath, isDirty: state.isDirty, live, mirror: state.content })) {
      return { outcome: 'clean' };
    }
    logger.store('SaveOnQuit', 'Sauvegarde avant fermeture', { filePath: state.filePath });
    await writeOpenDocumentWhileDirty();
    return { outcome: 'saved' };
  } catch (error) {
    logger.error('SaveOnQuit', error);
    if (overtaken()) return { outcome: 'clean' };
    return { outcome: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

export function useSaveOnQuit(): void {
  useEffect(() => {
    const api = window.electron?.lifecycle;
    if (!api) return;

    return api.onFlushBeforeQuit(() => {
      void flushOpenDocument().then((report) => api.flushDone(report));
    });
  }, []);
}
