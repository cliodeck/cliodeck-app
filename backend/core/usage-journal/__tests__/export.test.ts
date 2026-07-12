import { describe, expect, it } from 'vitest';
import { buildCsv, buildJsonl, buildMarkdown, isoWeekKey } from '../export.js';
import type { ExportInput } from '../export.js';
import type { InferenceEvent } from '../types.js';

function ev(p: Partial<InferenceEvent>): InferenceEvent {
  return {
    id: p.id ?? Math.random().toString(36).slice(2),
    sessionId: p.sessionId ?? 'S1',
    at: p.at ?? '2026-07-08T09:00:00.000Z',
    durationMs: 100,
    kind: p.kind ?? 'completion',
    provider: p.provider ?? 'anthropic',
    model: p.model ?? 'claude',
    isLocal: p.isLocal ?? false,
    promptTokens: p.promptTokens,
    completionTokens: p.completionTokens,
    totalTokens: p.totalTokens ?? 100,
    tokensEstimated: p.tokensEstimated ?? false,
    chunkCount: p.chunkCount,
    mode: p.mode ?? 'write',
    workspace: p.workspace ?? '/home/alice/these-lester',
    corpus: p.corpus,
    recipeId: p.recipeId,
    status: p.status ?? 'ok',
    ref: p.ref,
  };
}

const input: ExportInput = {
  events: [
    ev({ at: '2026-07-08T09:00:00.000Z', provider: 'anthropic', totalTokens: 500, mode: 'write' }),
    ev({ at: '2026-07-08T09:05:00.000Z', provider: 'ollama', isLocal: true, totalTokens: 200, mode: 'brainstorm' }),
    ev({ at: '2026-07-08T09:10:00.000Z', kind: 'embedding_batch', provider: 'ollama', isLocal: true, totalTokens: 3000, chunkCount: 40, corpus: 'lester-pdfs', mode: 'explore' }),
  ],
  decisions: [
    { id: 'D1', date: '2026-07-08', workspace: '/home/alice/these-lester', task: 'réindexation', alternative: 'lecture manuelle', justification: 'trop long', verdict: 'worth_it', verdictNote: 'gain net' },
  ],
  links: [],
  from: '2026-07-06T00:00:00.000Z',
  to: '2026-07-12T23:59:59.999Z',
};

describe('isoWeekKey', () => {
  it('calcule la semaine ISO (lundi)', () => {
    // 2026-07-08 est un mercredi → semaine ISO 28
    expect(isoWeekKey('2026-07-08T09:00:00.000Z')).toBe('2026-W28');
  });
});

describe('buildMarkdown', () => {
  it('produit un doc structuré par semaine avec volumes, décisions et total', () => {
    const md = buildMarkdown(input);
    expect(md).toContain("# Journal d'usage IA");
    expect(md).toContain('## Semaine 2026-W28');
    expect(md).toContain('| Mode | Appels | Tokens |');
    expect(md).toContain('### Décisions');
    expect(md).toContain('**réindexation**');
    expect(md).toContain('valait le coup');
    // total tokens 500+200+3000 = 3700
    expect(md).toContain('3 700 tokens');
  });

  it('anonymise workspaces et corpus quand demandé', () => {
    const md = buildMarkdown(input, { anonymize: true });
    expect(md).not.toContain('these-lester');
    expect(md).not.toContain('lester-pdfs');
    expect(md).toContain('corpus-A');
  });
});

describe('buildCsv', () => {
  it('émet un en-tête + une ligne par événement', () => {
    const csv = buildCsv(input);
    const rows = csv.trim().split('\n');
    expect(rows[0]).toBe(
      'at,session_id,kind,provider,model,is_local,prompt_tokens,completion_tokens,total_tokens,tokens_estimated,chunk_count,mode,workspace,corpus,status'
    );
    expect(rows).toHaveLength(4); // header + 3 events
    expect(rows[3]).toContain('embedding_batch');
  });
});

describe('buildJsonl', () => {
  it('une ligne par enregistrement, typée', () => {
    const jsonl = buildJsonl(input).trim().split('\n');
    expect(jsonl).toHaveLength(4); // 3 events + 1 decision
    expect(JSON.parse(jsonl[0]).type).toBe('event');
    expect(JSON.parse(jsonl[3]).type).toBe('decision');
  });
});
