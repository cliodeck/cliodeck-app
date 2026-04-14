import { describe, it, expect } from 'vitest';
import { inMemoryBM25Retriever } from '../in-memory-bm25.js';
import { runBenchmark, type BenchmarkDoc, type BenchmarkQuery } from '../../benchmark.js';

const docs: BenchmarkDoc[] = [
  {
    id: 'd1',
    chunks: [
      { id: 'd1-c1', content: 'Appel du 18 juin 1940 depuis Londres par De Gaulle.' },
      { id: 'd1-c2', content: 'Pétain et le régime de Vichy.' },
    ],
  },
  {
    id: 'd2',
    chunks: [
      { id: 'd2-c1', content: 'Recette de ratatouille : aubergines, courgettes, tomates.' },
    ],
  },
  {
    id: 'd3',
    chunks: [
      { id: 'd3-c1', content: 'Bataille de Verdun en 1916, une saignée pour la France.' },
      { id: 'd3-c2', content: 'Churchill et la Seconde Guerre mondiale.' },
    ],
  },
];

const queries: BenchmarkQuery[] = [
  { id: 'q1', text: 'De Gaulle Londres', relevant: ['d1-c1'] },
  { id: 'q2', text: 'Vichy Pétain', relevant: ['d1-c2'] },
  { id: 'q3', text: 'ratatouille aubergines', relevant: ['d2-c1'] },
  { id: 'q4', text: 'Verdun France', relevant: ['d3-c1'] },
];

describe('inMemoryBM25Retriever', () => {
  it('ranks the relevant chunk first on each query in this fixture', async () => {
    const result = await runBenchmark({
      docs,
      queries,
      retriever: inMemoryBM25Retriever(),
    });
    expect(result.recall[1]).toBe(1); // top-1 hits all 4 queries
    expect(result.mrr).toBe(1); // first rank for every query
  });

  it('returns no hits for an empty query', async () => {
    const r = inMemoryBM25Retriever();
    await r.index(docs);
    expect(await r.search('', 10)).toEqual([]);
  });

  it('returns no hits when no token matches', async () => {
    const r = inMemoryBM25Retriever();
    await r.index(docs);
    expect(await r.search('quantum chromodynamics', 10)).toEqual([]);
  });

  it('honours topK', async () => {
    const r = inMemoryBM25Retriever();
    await r.index(docs);
    const hits = await r.search('De Verdun Vichy', 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });
});
