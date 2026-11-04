/**
 * « Envoyer vers Write » : le texte de l'IA devient une proposition, depuis n'importe quel mode.
 *
 * L'éditeur n'est monté qu'en mode Écriture. Insérer avant de basculer écrivait donc le texte dans
 * le miroir, en fin de fichier, sans rien à accepter ni à annuler. On bascule, on attend l'éditeur,
 * puis on propose. S'il n'y a rien pour la recevoir, rien n'entre nulle part : à l'appelant de
 * garder le texte.
 */
import type { TFunction } from 'i18next';
import { useEditorStore } from '../stores/editorStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useProjectStore } from '../stores/projectStore';
import { logger } from '../utils/logger';
import { ensureWriteEditor } from './wait-for-facade';

/**
 * Rien ne peut recevoir une proposition : un changement de projet est en cours (la vue est en
 * lecture seule, ou va expirer tout ce qu'elle porte), ou un livre n'a aucun chapitre ouvert, et
 * son tampon sans titre n'est pas le manuscrit.
 */
export function noDocumentForProposal(): boolean {
  const { bufferDetached, filePath } = useEditorStore.getState();
  const { loadState, currentProject } = useProjectStore.getState();
  return bufferDetached || loadState.kind === 'loading' || (currentProject?.type === 'book' && !filePath);
}

/** Sans cela, un texte qui n'arrive pas dans l'éditeur semble perdu : le bouton n'est plus à l'écran. */
export function notifyDraftKept(t: TFunction): void {
  useNotificationStore.getState().notify({
    level: 'warning',
    title: t('editor.proposalUnavailable'),
    message: t('drafts.keptInQueue'),
  });
}

/** Ne rejette pas : tout ce qui n'a pas donné de proposition est `unavailable`, sans écriture. */
export async function sendDraftToWrite(
  block: string,
  source: { model?: string; task?: string }
): Promise<'proposed' | 'unavailable'> {
  if (noDocumentForProposal()) return 'unavailable';
  try {
    const facade = await ensureWriteEditor();
    if (!facade || noDocumentForProposal()) return 'unavailable';
    return useEditorStore.getState().insertDraftAtCursor(block, source).mode === 'cursor' ? 'proposed' : 'unavailable';
  } catch (error) {
    logger.error('sendDraftToWrite', error);
    return 'unavailable';
  }
}
