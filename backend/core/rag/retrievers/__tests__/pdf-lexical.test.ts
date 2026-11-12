import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import { pdfLexicalRetriever } from '../pdf-lexical.js';
import { runBenchmark, type BenchmarkDoc } from '../../benchmark.js';
import { BM25Index } from '../../../search/BM25Index.js';
import { HybridSearch } from '../../../search/HybridSearch.js';

const docs: BenchmarkDoc[] = [
  {
    id: 'd1',
    chunks: [
      { id: 'd1-c1', content: 'Bataille de Verdun en 1916, une saignée pour la France.' },
      { id: 'd1-c2', content: 'Les mutineries de 1917 après l’offensive Nivelle.' },
    ],
  },
  {
    id: 'd2',
    chunks: [
      { id: 'd2-c1', content: 'Die Gewerkschaften forderten den Achtstundentag.' },
      { id: 'd2-c2', content: 'Der Bau der Berliner Mauer begann 1961.' },
    ],
  },
];

const bancDirs = (): string[] =>
  fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('cliodeck-banc-'));

beforeEach(() => {
  // `BM25Index` et `HybridSearch` tracent chaque appel.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pdfLexicalRetriever', () => {
  it('trouve par le BM25 et la fusion de l’app, et trie par pertinence publiée', async () => {
    // Le banc doit voir tout changement de ces deux classes : il passe par elles, pas à côté.
    const bm25Search = vi.spyOn(BM25Index.prototype, 'search');
    const hybridSearch = vi.spyOn(HybridSearch.prototype, 'search');
    const retriever = pdfLexicalRetriever();
    await retriever.index(docs);

    const verdun = await retriever.search('Verdun 1916', 10);
    expect(hybridSearch).toHaveBeenCalledWith('Verdun 1916', expect.any(Float32Array), 10);
    expect(bm25Search).toHaveBeenCalledWith('Verdun 1916', 50, undefined);
    expect(verdun[0].chunkId).toBe('d1-c1');
    for (let i = 1; i < verdun.length; i++) {
      expect(verdun[i - 1].score).toBeGreaterThanOrEqual(verdun[i].score);
    }

    const mauer = await retriever.search('Berliner Mauer', 10);
    expect(mauer.map((h) => h.chunkId)).toEqual(['d2-c2']);
  });

  it('respecte topK et ne rend rien sur un mot absent', async () => {
    const retriever = pdfLexicalRetriever();
    await retriever.index(docs);
    expect(await retriever.search('Verdun 1916 Nivelle 1917', 1)).toHaveLength(1);
    expect(await retriever.search('ratatouille', 10)).toEqual([]);
  });

  it('se réindexe d’un corpus à l’autre', async () => {
    const retriever = pdfLexicalRetriever();
    await retriever.index(docs);
    await retriever.index([{ id: 'd3', chunks: [{ id: 'd3-c1', content: 'Le tarif Méline de 1892.' }] }]);
    expect(await retriever.search('Verdun', 10)).toEqual([]);
    expect((await retriever.search('tarif 1892', 10))[0].chunkId).toBe('d3-c1');
  });

  it('n’écrit rien sur le disque : l’index dense vide reste en mémoire', async () => {
    const before = bancDirs();
    const result = await runBenchmark({
      docs,
      queries: [{ id: 'q', text: 'Gewerkschaften', relevant: ['d2-c1'] }],
      retriever: pdfLexicalRetriever(),
    });
    expect(result.recall[1]).toBe(1);
    expect(bancDirs()).toEqual(before);
  });
});
