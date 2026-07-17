import type { ProposalAdjudicationEvent } from '@/editor/proposals';

/**
 * Accès défensif au canal d'adjudication (préload
 * `window.electron.proposals.recordAdjudication` → IPC
 * 'proposals:adjudication', routé côté main vers les deux journaux avec
 * leurs granularités respectives — voir docs/editor-proposals.md).
 *
 * Défensif : si le binding n'est pas (encore) exposé, on n'interrompt
 * jamais l'adjudication elle-même — no-op + warning en dev.
 */

interface ProposalsBridge {
  recordAdjudication: (event: ProposalAdjudicationEvent) => unknown;
}

let warned = false;

export function recordAdjudication(event: ProposalAdjudicationEvent): void {
  const bridge = (
    window.electron as unknown as { proposals?: Partial<ProposalsBridge> }
  ).proposals;

  if (bridge && typeof bridge.recordAdjudication === 'function') {
    try {
      void bridge.recordAdjudication(event);
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
