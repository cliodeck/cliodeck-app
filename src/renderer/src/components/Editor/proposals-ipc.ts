import type { ProposalAdjudicationEvent } from '@/editor/proposals';
import { useEditorStore } from '../../stores/editorStore';

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
type AdjudicationPayload = ProposalAdjudicationEvent & { filePath?: string };

interface ProposalsBridge {
  recordAdjudication: (event: AdjudicationPayload) => unknown;
}

let warned = false;

export function recordAdjudication(event: ProposalAdjudicationEvent): void {
  const bridge = (
    window.electron as unknown as { proposals?: Partial<ProposalsBridge> }
  ).proposals;

  if (bridge && typeof bridge.recordAdjudication === 'function') {
    try {
      const filePath = useEditorStore.getState().filePath ?? undefined;
      void bridge.recordAdjudication(filePath ? { ...event, filePath } : event);
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
