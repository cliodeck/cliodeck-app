import { describe, expect, it } from 'vitest';
import { summarize } from '../aggregate.js';
import type { InferenceEvent, SessionDecisionLink } from '../types.js';

function ev(partial: Partial<InferenceEvent>): InferenceEvent {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    sessionId: partial.sessionId ?? 'S1',
    at: partial.at ?? '2026-07-12T09:00:00.000Z',
    durationMs: partial.durationMs ?? 100,
    kind: partial.kind ?? 'completion',
    provider: partial.provider ?? 'anthropic',
    model: partial.model ?? 'claude',
    isLocal: partial.isLocal ?? false,
    promptTokens: partial.promptTokens,
    completionTokens: partial.completionTokens,
    totalTokens: partial.totalTokens,
    tokensEstimated: partial.tokensEstimated ?? false,
    chunkCount: partial.chunkCount,
    mode: partial.mode ?? 'brainstorm',
    workspace: partial.workspace ?? '/ws',
    corpus: partial.corpus,
    recipeId: partial.recipeId,
    status: partial.status ?? 'ok',
    ref: partial.ref,
  };
}

const RANGE = { from: '2026-07-12T00:00:00.000Z', to: '2026-07-13T00:00:00.000Z' };

describe('usage-journal aggregation', () => {
  it('ventile tokens par provider, mode, local/cloud', () => {
    const events = [
      ev({ provider: 'ollama', isLocal: true, mode: 'write', totalTokens: 100 }),
      ev({ provider: 'anthropic', isLocal: false, mode: 'brainstorm', totalTokens: 300 }),
      ev({ provider: 'anthropic', isLocal: false, mode: 'write', totalTokens: 200 }),
    ];
    const s = summarize(events, [], RANGE);
    expect(s.totalEvents).toBe(3);
    expect(s.totalTokens).toBe(600);
    expect(s.localTokens).toBe(100);
    expect(s.cloudTokens).toBe(500);
    // trié par tokens décroissant → anthropic (500) avant ollama (100)
    expect(s.byProvider[0]).toMatchObject({ provider: 'anthropic', totalTokens: 500, events: 2 });
    expect(s.byProvider[1]).toMatchObject({ provider: 'ollama', isLocal: true, totalTokens: 100 });
  });

  it('additionne prompt+completion quand totalTokens est absent', () => {
    const s = summarize([ev({ promptTokens: 10, completionTokens: 5 })], [], RANGE);
    expect(s.totalTokens).toBe(15);
  });

  it('agrège les corpus avec compte de chunks', () => {
    const events = [
      ev({ kind: 'embedding_batch', corpus: 'pdf', chunkCount: 40, totalTokens: 5000, mode: 'explore' }),
      ev({ kind: 'embedding_batch', corpus: 'pdf', chunkCount: 10, totalTokens: 1200, mode: 'explore' }),
    ];
    const s = summarize(events, [], RANGE);
    expect(s.byCorpus).toHaveLength(1);
    expect(s.byCorpus[0]).toMatchObject({ corpus: 'pdf', chunks: 50, totalTokens: 6200 });
  });

  it('détecte les sessions et marque comme violation une session substantielle non annotée', () => {
    const events = [
      // Session S1 : substantielle (4 appels), NON annotée → violation
      ev({ sessionId: 'S1', at: '2026-07-12T09:00:00.000Z', totalTokens: 50 }),
      ev({ sessionId: 'S1', at: '2026-07-12T09:05:00.000Z', totalTokens: 50 }),
      ev({ sessionId: 'S1', at: '2026-07-12T09:10:00.000Z', totalTokens: 50 }),
      ev({ sessionId: 'S1', at: '2026-07-12T09:15:00.000Z', totalTokens: 50 }),
      // Session S2 : 1 appel, non substantielle → pas une violation
      ev({ sessionId: 'S2', at: '2026-07-12T14:00:00.000Z', totalTokens: 20 }),
      // Session S3 : substantielle par tokens (>1000), annotée → pas une violation
      ev({ sessionId: 'S3', at: '2026-07-12T16:00:00.000Z', totalTokens: 2000 }),
    ];
    const links: SessionDecisionLink[] = [{ sessionId: 'S3', decisionId: 'D1' }];
    const s = summarize(events, links, RANGE);

    expect(s.sessions).toHaveLength(3);
    const s1 = s.sessions.find((x) => x.id === 'S1')!;
    expect(s1).toMatchObject({ events: 4, substantial: true, covered: false });
    expect(s1.startedAt).toBe('2026-07-12T09:00:00.000Z');
    expect(s1.endedAt).toBe('2026-07-12T09:15:00.000Z');

    expect(s.violations.map((v) => v.id)).toEqual(['S1']);
  });
});
