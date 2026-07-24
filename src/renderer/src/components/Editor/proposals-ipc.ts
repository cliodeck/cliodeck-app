import type { ProposalAdjudicationEvent } from '@/editor/proposals';
import { useEditorStore } from '../../stores/editorStore';
import { useProjectStore } from '../../stores/projectStore';

/**
 * Accès défensif au canal d'adjudication (préload
 * `window.electron.proposals.recordAdjudication` → IPC
 * 'proposals:adjudication', routé côté main vers les deux journaux avec
 * leurs granularités respectives — voir docs/editor-proposals.md).
 *
 * Défensif : si le binding n'est pas (encore) exposé, on n'interrompt
 * jamais l'adjudication elle-même — no-op + warning en dev.
 */

/**
 * L'événement enrichi du document où l'adjudication a eu lieu — un
 * chapitre, dans un manuscrit à N fichiers. La couche éditeur
 * (`src/editor/proposals`) ignore délibérément les projets : le chemin
 * est ajouté ICI, au passage vers le main, qui le route vers le SEUL
 * journal de recherche (le journal d'usage IA n'en reçoit jamais).
 */
type AdjudicationPayload = ProposalAdjudicationEvent & {
  filePath?: string;
  projectPath?: string;
};

interface ProposalsBridge {
  recordAdjudication: (event: AdjudicationPayload) => unknown;
}

let warned = false;

/**
 * `context` : document et projet auxquels la vue émettrice appartient,
 * capturés À LA CRÉATION de la vue. Indispensable pour l'événement
 * `expired` émis par `view.destroy()` lors d'une bascule de chapitre ou
 * de projet : à ce moment les stores portent déjà les chemins du NOUVEAU
 * document/projet, et les lire ici attribuait l'expiration au mauvais
 * chapitre (et le handler main, au mauvais journal). Sans contexte
 * explicite, repli sur l'état courant des stores (adjudications
 * synchrones : accept/reject/modify).
 */
export function recordAdjudication(
  event: ProposalAdjudicationEvent,
  context?: { filePath?: string; projectPath?: string }
): void {
  const bridge = (
    window.electron as unknown as { proposals?: Partial<ProposalsBridge> }
  ).proposals;

  if (bridge && typeof bridge.recordAdjudication === 'function') {
    try {
      const filePath =
        context?.filePath ?? useEditorStore.getState().filePath ?? undefined;
      const projectPath =
        context?.projectPath ??
        useProjectStore.getState().currentProject?.path ??
        undefined;
      void bridge.recordAdjudication({
        ...event,
        ...(filePath ? { filePath } : {}),
        ...(projectPath ? { projectPath } : {}),
      });
    } catch (error) {
      console.warn('[proposals] échec d’émission de l’adjudication', error);
    }
    return;
  }

  const meta = import.meta as unknown as { env?: { DEV?: boolean } };
  if (meta.env?.DEV && !warned) {
    warned = true;
    console.warn(
      '[proposals] window.electron.proposals.recordAdjudication absent — ' +
        'événements d’adjudication non journalisés (canal Phase 4c).'
    );
  }
}
