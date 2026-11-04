// @vitest-environment jsdom
/**
 * `onceProposalDecided` : tout ce qui attend une décision la reçoit, quoi qu'il arrive au canal
 * vers le main. Si le déclenchement passait après la garde du préload, un brouillon resterait à
 * jamais marqué « proposé ».
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProposalAdjudicationEvent, ProposalDecision } from '@/editor/proposals';
import { onceProposalDecided, recordAdjudication } from '../proposals-ipc';

function eventOf(proposalId: string, decision: ProposalDecision): ProposalAdjudicationEvent {
  return {
    proposalId,
    decision,
    category: 'brainstorm-draft',
    model: 'm',
    task: 't',
    latencyMs: 0,
    at: '2026-11-04T00:00:00Z',
  };
}

function installBridge(bridge: unknown): void {
  (window as unknown as { electron: unknown }).electron = { proposals: bridge };
}

afterEach(() => {
  installBridge({ recordAdjudication: () => undefined });
});

describe('onceProposalDecided', () => {
  it.each<ProposalDecision>(['accepted', 'modified', 'rejected', 'invalidated', 'expired'])(
    'décision « %s » : déclenché une fois, puis décroché',
    (decision) => {
      installBridge({ recordAdjudication: () => undefined });
      const callback = vi.fn();
      onceProposalDecided(`p-${decision}`, callback);

      recordAdjudication(eventOf(`p-${decision}`, decision));
      recordAdjudication(eventOf(`p-${decision}`, 'accepted'));

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(decision);
    }
  );

  it('n’entend que sa proposition', () => {
    const callback = vi.fn();
    onceProposalDecided('la-mienne', callback);

    recordAdjudication(eventOf('une-autre', 'accepted'));

    expect(callback).not.toHaveBeenCalled();
  });

  it('se décroche avant la décision', () => {
    const callback = vi.fn();
    const off = onceProposalDecided('annulee', callback);

    off();
    recordAdjudication(eventOf('annulee', 'accepted'));

    expect(callback).not.toHaveBeenCalled();
  });

  it('déclenché même si le canal du préload est absent', () => {
    (window as unknown as { electron: unknown }).electron = {};
    const callback = vi.fn();
    onceProposalDecided('sans-canal', callback);

    recordAdjudication(eventOf('sans-canal', 'expired'));

    expect(callback).toHaveBeenCalledWith('expired');
  });

  it('déclenché même si le canal lève', () => {
    installBridge({
      recordAdjudication: () => {
        throw new Error('canal en panne');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const callback = vi.fn();
    onceProposalDecided('canal-en-panne', callback);

    recordAdjudication(eventOf('canal-en-panne', 'accepted'));

    expect(callback).toHaveBeenCalledWith('accepted');
    warn.mockRestore();
  });

  it('un écouteur qui lève n’empêche ni les autres ni le journal', () => {
    const recorded = vi.fn();
    installBridge({ recordAdjudication: recorded });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const after = vi.fn();
    onceProposalDecided('fragile', () => {
      throw new Error('écouteur en panne');
    });
    onceProposalDecided('fragile', after);

    recordAdjudication(eventOf('fragile', 'rejected'));

    expect(after).toHaveBeenCalledWith('rejected');
    expect(recorded).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
