/**
 * Reclassement des recommandations par le modèle (L09-7) : `complete()` rejette désormais quand le
 * fournisseur tombe. Le reclassement est un bonus ; sa panne garde l'ordre de la recherche, sans
 * perdre une recommandation. Fournisseur réel, `fetch` simulé : rien ne part en ligne.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const search = vi.fn();
vi.mock('../pdf-service.js', () => ({ pdfService: { search: (...args: unknown[]) => search(...args) } }));
vi.mock('../project-manager.js', () => ({ projectManager: { getCurrentProjectPath: () => null } }));

import { OllamaProvider } from '../../../../backend/core/llm/providers/ollama.js';
import {
  resolveSimilarityOptions,
  similarityService,
  type PDFRecommendation,
  type SimilarityOptions,
  type TextSegment,
} from '../similarity-service.js';

type WithFind = {
  findSimilarPDFs(segment: TextSegment, options: SimilarityOptions): Promise<PDFRecommendation[]>;
};

const hit = (id: string, title: string, similarity: number): unknown => ({
  sourceType: 'secondary',
  similarity,
  document: { id, title, author: 'Berlière' },
  chunk: { content: `Extrait de ${title}`, pageNumber: 1 },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  similarityService.setLLMProvider(null);
});

describe('similarité — le reclassement par le modèle tombe', () => {
  it('garde l’ordre de la recherche et toutes les recommandations', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: 'model runner has unexpectedly stopped' }), { status: 500 })
    );
    similarityService.setLLMProvider(
      new OllamaProvider({ model: 'qwen3:8b', baseUrl: 'http://mock.ollama' })
    );
    search.mockResolvedValue([
      hit('a', 'La police parisienne', 0.8),
      hit('b', 'Le 6 février 1934', 0.6),
      hit('c', 'Chiappe', 0.4),
    ]);

    const out = await (similarityService as unknown as WithFind).findSimilarPDFs(
      {
        id: 's1',
        content: 'Le préfet Chiappe est muté au Maroc en février 1934.',
        startLine: 1,
        endLine: 1,
        type: 'paragraph',
      },
      resolveSimilarityOptions({ useReranking: true, useContextualEmbedding: false })
    );

    expect(out.map((r) => r.pdfId)).toEqual(['a', 'b', 'c']);
  });
});
