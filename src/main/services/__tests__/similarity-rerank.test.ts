/**
 * Reclassement des recommandations par le modèle (S13-1-33, S13-2-0).
 *
 * Le reclassement remplaçait la similarité de chaque candidat par un score de rang,
 * (n − rang) / n : le premier affichait toujours « 100 % », quelle que soit sa proximité réelle.
 * Or la `similarity` d'un résultat est sur l'échelle du cosinus (contrat Path A′, CLAUDE.md §2) :
 * seul l'ordre vient du modèle.
 *
 * L'aperçu d'un candidat, dans le prompt comme sur la carte, était le début brut de l'extrait :
 * le préfixe « [Doc: <titre>] », puis le recouvrement, c'est-à-dire la fin de l'extrait précédent.
 * Le modèle classait sur le titre, écrit deux fois, et sur du texte voisin ; l'historien lisait un
 * autre passage que celui qui a été trouvé.
 *
 * Vrais service et `AdaptiveChunker` (celui de l'indexation des PDF). Simulés : la recherche, qui
 * rend les extraits, et le modèle, qui rend un classement et garde le prompt reçu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const search = vi.fn();
vi.mock('../pdf-service.js', () => ({ pdfService: { search: (...args: unknown[]) => search(...args) } }));
vi.mock('../project-manager.js', () => ({ projectManager: { getCurrentProjectPath: () => null } }));

import { AdaptiveChunker } from '../../../../backend/core/chunking/AdaptiveChunker.js';
import type {
  ChatChunk,
  ChatMessage,
  LLMProvider,
  ProviderStatus,
} from '../../../../backend/core/llm/providers/base.js';
import type { DocumentPage } from '../../../../backend/types/pdf-document.js';
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

/** Un modèle qui rend toujours le même classement, et garde chaque prompt reçu. */
class RankingLLM implements LLMProvider {
  readonly id = 'ranking';
  readonly name = 'Ranking';
  readonly model = 'ranking-model';
  readonly capabilities = { chat: true, streaming: false, tools: false, embeddings: false };
  readonly prompts: string[] = [];
  constructor(private readonly answer: string) {}
  getStatus(): ProviderStatus {
    return { state: 'ready' };
  }
  async healthCheck(): Promise<ProviderStatus> {
    return { state: 'ready' };
  }
  async *chat(messages: ChatMessage[]): AsyncIterable<ChatChunk> {
    this.prompts.push(messages.map((m) => m.content).join('\n'));
    yield { delta: this.answer };
    yield { delta: '', done: true, finishReason: 'stop' };
  }
  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.answer;
  }
  async dispose(): Promise<void> {}
}

const segment = (content: string): TextSegment => ({ id: 's1', content, startLine: 1, endLine: 1, type: 'paragraph' });

const find = (content: string) =>
  (similarityService as unknown as WithFind).findSimilarPDFs(
    segment(content),
    resolveSimilarityOptions({ useReranking: true, useContextualEmbedding: false })
  );

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  search.mockReset();
  similarityService.setLLMProvider(null);
});

describe('reclassement — la similarité reste le cosinus (S13-1-33)', () => {
  it('cosinus 0,31 / 0,29 / 0,20 et « 3, 1, 2 » : l’ordre c, a, b, avec les cosinus d’origine', async () => {
    const hit = (id: string, similarity: number) => ({
      sourceType: 'secondary',
      similarity,
      document: { id, title: `Titre ${id}`, author: 'Berstein' },
      chunk: { content: `Extrait ${id} sur la police parisienne en 1934.`, pageNumber: 1 },
    });
    search.mockResolvedValue([hit('a', 0.31), hit('b', 0.29), hit('c', 0.2)]);
    similarityService.setLLMProvider(new RankingLLM('3, 1, 2'));

    const out = await find('Le préfet Chiappe est muté au Maroc en février 1934.');

    expect(out.map((r) => [r.pdfId, r.similarity])).toEqual([
      ['c', 0.2],
      ['a', 0.31],
      ['b', 0.29],
    ]);
  });
});

describe('reclassement et aperçu — le passage trouvé, pas le titre ni l’extrait voisin (S13-2-0)', () => {
  const TITLES: Record<string, string> = {
    A: 'Les syndicats européens face à la Communauté économique européenne, 1950-1957',
    B: 'La Haute Autorité et les mineurs de la Ruhr',
    C: 'Charbon et acier : les syndicats chrétiens dans la CECA',
  };

  /** Soixante phrases numérotées (« dossier A12 »), vingt par page, une ligne par page comme un PDF extrait. */
  const pages = (letter: string): DocumentPage[] =>
    [0, 1, 2].map((p) => ({
      pageNumber: p + 1,
      text: Array.from(
        { length: 20 },
        (_, s) => `La Haute Autorité examine le dossier ${letter}${p * 20 + s + 1} avec les syndicats de la Ruhr.`
      ).join(' '),
    }));

  const numbers = (letter: string, text: string): number[] =>
    [...text.matchAll(new RegExp(`\\b${letter}(\\d+)\\b`, 'g'))].map((m) => Number(m[1]));

  /** Le troisième extrait de chaque document, et les dossiers qui lui sont propres (hors recouvrement). */
  const third = (letter: string) => {
    const chunks = new AdaptiveChunker().createChunks(pages(letter), `doc-${letter}`, { title: TITLES[letter] });
    const previous = new Set(numbers(letter, chunks[1].content));
    const own = numbers(letter, chunks[2].content).filter((n) => !previous.has(n));
    const overlap = numbers(letter, chunks[2].content).filter((n) => previous.has(n));
    return { chunk: chunks[2], own, overlap };
  };

  const DOCS = ['A', 'B', 'C'].map((letter) => ({ letter, ...third(letter) }));

  beforeEach(() => {
    // Témoin : l'extrait commence bien par le préfixe, puis par un recouvrement.
    for (const { chunk, own, overlap } of DOCS) {
      expect(chunk.content.startsWith('[Doc: ')).toBe(true);
      expect(overlap.length).toBeGreaterThan(0);
      expect(own.length).toBeGreaterThan(5);
    }
    search.mockResolvedValue(
      DOCS.map(({ letter, chunk }, i) => ({
        sourceType: 'secondary',
        similarity: 0.4 - i * 0.05,
        document: { id: `doc-${letter}`, title: TITLES[letter], author: 'Spierenburg' },
        chunk,
      }))
    );
  });

  /** Les dossiers cités dans `text` sont tous propres à l'extrait, et il y en a. */
  const expectOwnPassage = (letter: string, text: string) => {
    const doc = DOCS.find((d) => d.letter === letter)!;
    const cited = numbers(letter, text);
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.filter((n) => !doc.own.includes(n))).toEqual([]);
  };

  it('le prompt : ni « [Doc: », ni le titre deux fois, et le passage propre de chaque extrait', async () => {
    const llm = new RankingLLM('2, 1, 3');
    similarityService.setLLMProvider(llm);

    await find('Les syndicats de la Ruhr devant la Haute Autorité de la CECA.');

    expect(llm.prompts).toHaveLength(1);
    const prompt = llm.prompts[0];
    expect(prompt).not.toContain('[Doc:');
    for (const { letter } of DOCS) {
      expect(prompt.split(TITLES[letter]).length - 1).toBe(1);
      const line = prompt.split('\n').find((l) => l.includes(`"${TITLES[letter]}"`))!;
      expectOwnPassage(letter, line);
    }
  });

  it('l’aperçu de la carte : le passage propre, sans le préfixe', async () => {
    similarityService.setLLMProvider(new RankingLLM('1, 2, 3'));

    const out = await find('Les syndicats de la Ruhr devant la Haute Autorité de la CECA.');

    expect(out).toHaveLength(3);
    for (const rec of out) {
      expect(rec.chunkPreview).not.toContain('[Doc:');
      expectOwnPassage(rec.pdfId.replace('doc-', ''), rec.chunkPreview);
    }
  });
});
