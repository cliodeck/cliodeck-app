/**
 * Proposer un brouillon de la file (#7, A13 option c) : par son bouton, au curseur, ou en glissant
 * sa carte dans l'éditeur, au point de dépôt (décision D9). Les deux chemins font la même
 * proposition (`editorStore.proposeDraftAt`) et suivent la même décision : seule l'acceptation fait
 * sortir le brouillon de la file.
 */
import type { TFunction } from 'i18next';
import { useDraftsStore } from '../../stores/draftsStore';
import { useEditorStore, type DraftInsertion } from '../../stores/editorStore';
import { noDocumentForProposal, notifyDraftKept } from '../../services/send-draft-to-write';
import { logger } from '../../utils/logger';
import { onceProposalDecided } from './proposals-ipc';

/**
 * Le type propre à ClioDeck d'une carte glissée, porteur de l'identifiant du brouillon : l'éditeur
 * le reconnaît et propose au lieu d'insérer. La carte porte aussi `text/plain`, pour un dépôt hors
 * de ClioDeck, qui n'est qu'une copie.
 */
export const DRAFT_DRAG_TYPE = 'application/x-cliodeck-draft';

/**
 * Hors du composant : quand la décision tombe, le panneau a pu se fermer et le mode changer.
 * Accepté ou modifié, le texte est entré. Rejeté, invalidé ou expiré, il ne serait plus nulle part.
 */
function followProposal(draftId: string, proposalId: string): void {
  useDraftsStore.getState().setProposed(draftId, true);
  onceProposalDecided(proposalId, (decision) => {
    const drafts = useDraftsStore.getState();
    drafts.setProposed(draftId, false);
    if (decision === 'accepted' || decision === 'modified') drafts.remove(draftId);
  });
}

/**
 * Propose le brouillon au curseur, ou à l'offset du document que rend `at`, le point de dépôt. Ce
 * point se calcule ici, sous la même garde que la proposition. Sans rien pour le recevoir, ou sans
 * point de dépôt, rien n'entre nulle part, le brouillon reste dans la file et un message le dit. Un
 * brouillon jeté entre-temps, ou qui attend déjà sa décision, n'est pas proposé une seconde fois.
 */
export function proposeQueuedDraft(draftId: string, at: 'cursor' | (() => number), t: TFunction): void {
  const { drafts, proposedIds } = useDraftsStore.getState();
  const draft = drafts.find((d) => d.id === draftId);
  if (!draft || proposedIds.includes(draftId)) return;
  let outcome: DraftInsertion | null = null;
  try {
    if (!noDocumentForProposal()) {
      const editor = useEditorStore.getState();
      outcome =
        at === 'cursor'
          ? editor.insertDraftAtCursor(draft.content, draft.source)
          : editor.proposeDraftAt(at(), draft.content, draft.source);
    }
  } catch (error) {
    logger.error('proposeQueuedDraft', error);
  }
  if (outcome?.mode === 'cursor') followProposal(draft.id, outcome.proposalId);
  else notifyDraftKept(t);
}
