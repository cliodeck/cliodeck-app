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
