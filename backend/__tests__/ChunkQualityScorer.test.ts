/**
 * Filtre de qualité des extraits — celui de l'indexation des PDF et des
 * archives Tropy.
 *
 * Il exigeait une phrase (une ponctuation finale suivie d'un blanc) de tout
 * extrait, quelle que soit sa longueur. Un inventaire, une liste nominative ou
 * un tableau sans ponctuation, que le découpage recoupe exprès en tranches de
 * mots (#157), était jeté en entier, sans le moindre signe : le PDF était dit
 * indexé, ces pages n'existaient pas dans l'index (S03-1-27). Une phrase n'est
 * plus exigée que d'un fragment, moins de 50 mots.
 */
import { describe, it, expect } from 'vitest';
import { ChunkQualityScorer, type QualityFilterConfig } from '../core/chunking/ChunkQualityScorer.js';
import { AdaptiveChunker } from '../core/chunking/AdaptiveChunker.js';
import { CHUNKING_CONFIGS } from '../core/chunking/DocumentChunker.js';

/** Les réglages que `PDFIndexer` passe au filtre (valeurs par défaut de la configuration RAG). */
const PDF_FILTER: Partial<QualityFilterConfig> = { minEntropy: 0.3, minUniqueWordRatio: 0.4 };

const SYLLABLES = ['ba', 'cor', 'di', 'fu', 'gal', 'le', 'mi', 'nor', 'pa', 'ru', 'sel', 'to', 'van', 'ze', 'qui', 'ran', 'tel', 'mor'];
/** Un mot inventé, distinct pour chaque `n` : des cotes et des noms que rien ne répète. */
function word(n: number): string {
  let s = '';
  for (let k = 0, x = n; k < 3; k++, x = Math.floor(x / SYLLABLES.length)) s += SYLLABLES[x % SYLLABLES.length];
  return s;
}
const words = (text: string) => text.match(/\S+/g) ?? [];

/**
 * Un inventaire d'archives tel qu'un PDF l'extrait : une seule ligne, un court
 * énoncé, puis 1 200 mots sans un point — 200 articles « liasse n, quatre mots ».
 */
const INVENTORY_ITEMS = Array.from(
  { length: 200 },
  (_, i) => `liasse ${i + 1} ${[0, 1, 2, 3].map((k) => word(4 * i + k)).join(' ')}`
).join(' ');
const INVENTORY = `Inventaire sommaire des liasses. ${INVENTORY_ITEMS}`;

describe('ChunkQualityScorer — listes et inventaires sans ponctuation (S03-1-27)', () => {
  it('un inventaire de 1 200 mots sans point, découpé par AdaptiveChunker : tous ses extraits sont retenus', () => {
    expect(words(INVENTORY_ITEMS)).toHaveLength(1200);
    const chunks = new AdaptiveChunker(CHUNKING_CONFIGS.cpuOptimized).createChunks(
      [{ pageNumber: 1, text: INVENTORY }],
      'doc',
      { title: 'Inventaire de la série M' }
    );

    const { passed, stats } = new ChunkQualityScorer().filterByQuality(chunks, PDF_FILTER, false);

    // Avant correction : 5 extraits, 0 retenu (un de 6 mots, quatre tranches sans phrase).
    expect(stats.totalChunks).toBeGreaterThan(1);
    expect(passed).toHaveLength(chunks.length);
    // Aucun article de l'inventaire ne manque à l'index.
    const kept = new Set(passed.flatMap((chunk) => words(chunk.content)));
    for (const w of words(INVENTORY)) expect(kept.has(w)).toBe(true);
  });

  it('un fragment de 12 mots sans ponctuation est toujours écarté', () => {
    const scorer = new ChunkQualityScorer();
    const fragment = Array.from({ length: 12 }, (_, i) => word(i)).join(' ');

    const score = scorer.scoreChunk(fragment);

    expect(score.wordCount).toBe(12);
    expect(scorer.meetsQualityThreshold(score, PDF_FILTER)).toBe(false);
  });

  it('sous 50 mots, une phrase reste exigée ; à 50 mots, plus', () => {
    const scorer = new ChunkQualityScorer();
    const list = (n: number) => Array.from({ length: n }, (_, i) => word(i)).join(' ');

    expect(scorer.getRejectionReason(scorer.scoreChunk(list(49)), PDF_FILTER)).toBe('too few sentences (0 < 1)');
    expect(scorer.getRejectionReason(scorer.scoreChunk(list(50)), PDF_FILTER)).toBeNull();
    expect(scorer.meetsQualityThreshold(scorer.scoreChunk(list(50)), PDF_FILTER)).toBe(true);
  });

  it('la raison donnée et la décision disent la même chose', () => {
    const scorer = new ChunkQualityScorer();
    const samples = [
      Array.from({ length: 12 }, (_, i) => word(i)).join(' '),
      Array.from({ length: 30 }, (_, i) => word(i)).join(' '),
      Array.from({ length: 80 }, (_, i) => word(i)).join(' '),
      `${Array.from({ length: 25 }, (_, i) => word(i)).join(' ')}.`,
      'STOP '.repeat(60),
      INVENTORY,
    ];
    for (const config of [PDF_FILTER, { minSentenceCount: 0, minWordCount: 3 }]) {
      for (const sample of samples) {
        const score = scorer.scoreChunk(sample);
        expect(scorer.meetsQualityThreshold(score, config)).toBe(scorer.getRejectionReason(score, config) === null);
      }
    }
  });
});

describe('ChunkQualityScorer — le meilleur extrait quand tous sont écartés', () => {
  const scorer = new ChunkQualityScorer();
  /** Une feuille d'appel : « N k présent », de `from` à `to`. */
  const tally = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `N ${from + i} présent`).join(' ');

  it('garde le plus long, même quand une courte fin a un meilleur score', () => {
    // La fin d'une feuille d'appel, déjà dans l'extrait d'avant : moins de
    // répétitions, donc un meilleur score, et presque rien à retrouver.
    const body = { content: tally(1, 100) };
    const tail = { content: tally(99, 100) };
    expect(scorer.scoreChunk(tail.content).overallScore).toBeGreaterThan(scorer.scoreChunk(body.content).overallScore);

    expect(scorer.bestChunk([body, tail])).toBe(body);
    expect(scorer.bestChunk([tail, body])).toBe(body);
  });

  it('à longueur égale, le meilleur score ; à longueur et score égaux, le premier', () => {
    const prose = { content: `${Array.from({ length: 29 }, (_, i) => word(i)).join(' ')}.` };
    const repetitive = { content: tally(1, 10).split(' ').slice(0, 29).join(' ') };
    expect(scorer.scoreChunk(prose.content).wordCount).toBe(scorer.scoreChunk(repetitive.content).wordCount);
    expect(scorer.scoreChunk(prose.content).overallScore).toBeGreaterThan(scorer.scoreChunk(repetitive.content).overallScore);
    expect(scorer.bestChunk([repetitive, prose])).toBe(prose);

    const first = { content: 'alpha bravo delta gamma' };
    const second = { content: 'alpha bravo delta gamma' };
    expect(scorer.bestChunk([first, second])).toBe(first);
    expect(scorer.bestChunk([second, first])).toBe(second);
  });

  it('aucun extrait : rien', () => {
    expect(scorer.bestChunk([])).toBeUndefined();
  });
});
