import { describe, it, expect } from 'vitest';
import {
  diffResults,
  runBenchmark,
  type BenchmarkDoc,
  type BenchmarkQuery,
  type Retriever,
} from '../benchmark';

const docs: BenchmarkDoc[] = [
  {
    id: 'd1',
    chunks: [
      { id: 'd1-c1', content: 'Appel du 18 juin 1940 depuis Londres.' },
      { id: 'd1-c2', content: 'Pétain et le régime de Vichy.' },
    ],
  },
  {
    id: 'd2',
    chunks: [
      { id: 'd2-c1', content: 'Recette de ratatouille : aubergines, courgettes.' },
    ],
  },
  {
    id: 'd3',
    chunks: [
      { id: 'd3-c1', content: 'Bataille de Verdun, 1916.' },
      { id: 'd3-c2', content: 'Churchill et la Seconde Guerre mondiale.' },
    ],
  },
];

const queries: BenchmarkQuery[] = [
  { id: 'q1', text: 'De Gaulle Londres', relevant: ['d1-c1'] },
  { id: 'q2', text: 'Vichy Pétain', relevant: ['d1-c2'] },
  { id: 'q3', text: 'ratatouille', relevant: ['d2-c1'] },
  { id: 'q4', text: 'Verdun', relevant: ['d3-c1'] },
];

/**
 * Simple substring-overlap retriever. Good enough to produce meaningful
 * recall/mrr numbers on the synthetic fixture — the point is to exercise
 * the harness wiring, not to validate a retrieval algorithm.
 */
function overlapRetriever(): Retriever {
  let corpus: Array<{ id: string; content: string }> = [];
  return {
    async index(ds) {
      corpus = ds.flatMap((d) => d.chunks);
    },
    async search(queryText, topK) {
      const tokens = queryText
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2);
      const scored = corpus.map((c) => {
        const hay = c.content.toLowerCase();
        const score = tokens.reduce(
          (s, t) => s + (hay.includes(t) ? 1 : 0),
          0
        );
        return { chunkId: c.id, score };
      });
      return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    },
  };
}

describe('RAG benchmark harness (2.4a)', () => {
  it('computes recall@K, MRR, and latency percentiles', async () => {
    const result = await runBenchmark({
      docs,
      queries,
      retriever: overlapRetriever(),
    });
    expect(result.queryCount).toBe(4);
    expect(result.recall[1]).toBeGreaterThan(0);
    expect(result.recall[10]).toBeGreaterThanOrEqual(result.recall[1]);
    expect(result.mrr).toBeGreaterThan(0);
    expect(result.mrr).toBeLessThanOrEqual(1);
    expect(result.latencyMs.mean).toBeGreaterThanOrEqual(0);
    expect(result.perQuery).toHaveLength(4);
  });

  it('reports null firstRelevantRank when no relevant hit is found', async () => {
    const always = overlapRetriever();
    const result = await runBenchmark({
      docs,
      queries: [
        { id: 'miss', text: 'quantum chromodynamics', relevant: ['d1-c1'] },
      ],
      retriever: always,
    });
    expect(result.perQuery[0].firstRelevantRank).toBeNull();
    expect(result.mrr).toBe(0);
    expect(result.recall[1]).toBe(0);
  });

  it('respects the custom ks parameter', async () => {
    const result = await runBenchmark({
      docs,
      queries,
      retriever: overlapRetriever(),
      ks: [2, 5],
    });
    expect(Object.keys(result.recall).sort()).toEqual(['2', '5']);
  });

  it('diffResults shapes a before/after delta', async () => {
    const before = await runBenchmark({
      docs,
      queries: queries.slice(0, 2),
      retriever: overlapRetriever(),
    });
    const after = await runBenchmark({
      docs,
      queries,
      retriever: overlapRetriever(),
    });
    const diff = diffResults(before, after);
    expect(typeof diff.mrrDelta).toBe('number');
    expect(typeof diff.meanLatencyDelta).toBe('number');
    expect(Object.keys(diff.recallDelta).length).toBeGreaterThan(0);
  });

  // S04-1-20 : `recall[K]` ne retenait que le rang du premier pertinent, donc
  // publiait le taux de succès. Trois pertinents, un seul rendu : le rappel
  // est d'un tiers, le taux de succès de 1.
  it('recall@K compte la part des pertinents retrouvés ; hitRate@K garde l’ancienne mesure', async () => {
    const onlyFirst: Retriever = {
      async index() {},
      async search() {
        return [
          { chunkId: 'c1', score: 3 },
          { chunkId: 'x1', score: 2 },
          { chunkId: 'x2', score: 1 },
        ];
      },
    };
    const result = await runBenchmark({
      docs,
      queries: [{ id: 'q', text: 'peu importe', relevant: ['c1', 'c2', 'c3'] }],
      retriever: onlyFirst,
    });
    expect(result.recall[10]).toBeCloseTo(1 / 3, 10);
    expect(result.recall[1]).toBeCloseTo(1 / 3, 10);
    expect(result.hitRate[10]).toBe(1);
    expect(result.hitRate[1]).toBe(1);
    expect(result.perQuery[0].relevantFound).toBe(1);
    expect(result.perQuery[0].relevantCount).toBe(3);
  });

  it('recall@K est la moyenne des rappels par question, au rang K', async () => {
    // q1 : deux pertinents, l'un au rang 1, l'autre au rang 4.
    // q2 : un pertinent, jamais rendu.
    const ranked: Retriever = {
      async index() {},
      async search(text) {
        if (text === 'q1') {
          return ['a', 'n1', 'n2', 'b'].map((chunkId, i) => ({ chunkId, score: 10 - i }));
        }
        return [{ chunkId: 'n1', score: 1 }];
      },
    };
    const result = await runBenchmark({
      docs,
      queries: [
        { id: 'q1', text: 'q1', relevant: ['a', 'b'] },
        { id: 'q2', text: 'q2', relevant: ['z'] },
      ],
      retriever: ranked,
    });
    // Rang 1 et 3 : q1 = 1/2, q2 = 0 → 1/4. Rang 5 : q1 = 1 → 1/2.
    expect(result.recall[1]).toBeCloseTo(0.25, 10);
    expect(result.recall[3]).toBeCloseTo(0.25, 10);
    expect(result.recall[5]).toBeCloseTo(0.5, 10);
    expect(result.hitRate[1]).toBe(0.5);
    expect(result.hitRate[5]).toBe(0.5);
  });

  // Un retriever qui fusionne des variantes sans dédoublonner peut rendre deux
  // fois le même extrait : compté deux fois, il ferait monter le rappel au-delà
  // de la part réelle, jusqu'à 1 ici alors que c2 n'est jamais rendu.
  it('un extrait pertinent rendu deux fois ne compte qu’une fois', async () => {
    const withDuplicate: Retriever = {
      async index() {},
      async search() {
        return [
          { chunkId: 'c1', score: 3 },
          { chunkId: 'c1', score: 2 },
          { chunkId: 'x1', score: 1 },
        ];
      },
    };
    const result = await runBenchmark({
      docs,
      queries: [{ id: 'q', text: 'peu importe', relevant: ['c1', 'c2'] }],
      retriever: withDuplicate,
    });
    expect(result.recall[10]).toBeCloseTo(1 / 2, 10);
    expect(result.recall[3]).toBeCloseTo(1 / 2, 10);
    expect(result.perQuery[0].relevantFound).toBe(1);
    expect(result.perQuery[0].relevantCount).toBe(2);
    expect(result.perQuery[0].firstRelevantRank).toBe(1);
  });

  it('diffResults donne l’écart du rappel et celui du taux de succès', async () => {
    const before = await runBenchmark({
      docs,
      queries: queries.slice(0, 2),
      retriever: overlapRetriever(),
    });
    const after = await runBenchmark({
      docs,
      queries,
      retriever: overlapRetriever(),
    });
    const diff = diffResults(before, after);
    expect(diff.hitRateDelta[10]).toBeCloseTo(after.hitRate[10] - before.hitRate[10], 10);
    expect(diff.recallDelta[10]).toBeCloseTo(after.recall[10] - before.recall[10], 10);
  });

  it('calls close() on the retriever when provided', async () => {
    let closed = false;
    const r = overlapRetriever();
    r.close = async () => {
      closed = true;
    };
    await runBenchmark({ docs, queries: queries.slice(0, 1), retriever: r });
    expect(closed).toBe(true);
  });
});
