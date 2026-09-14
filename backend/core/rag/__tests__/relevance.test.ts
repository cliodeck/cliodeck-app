/**
 * Contrat de pertinence commun aux quatre corpus (Path A′).
 *
 * Les constantes viennent de `HybridSearch` (PDF), où elles étaient codées en
 * dur : le premier test fige la formule d'avant, pour que la mise en commun
 * ne déplace pas silencieusement le classement de la bibliographie.
 */
import { describe, expect, it } from 'vitest';
import {
  applyThreshold,
  CROSS_LANGUAGE_FALLBACK,
  relevanceScore,
  sparseRankRelevance,
  SPARSE_BOOST_RANK,
  SPARSE_FLOOR,
} from '../relevance.js';

/** La formule telle qu'elle vivait dans HybridSearch avant la mise en commun. */
function legacyHybridSearch(dense: number, sparseRank: number | null): number {
  const synthetic =
    sparseRank !== null && sparseRank <= 50
      ? Math.max(0.15, 0.7 - 0.02 * (sparseRank - 1))
      : 0;
  return Math.max(dense, synthetic);
}

describe('relevanceScore', () => {
  it('reproduit exactement la formule historique des PDF', () => {
    for (const dense of [0, 0.05, 0.12, 0.33, 0.8]) {
      for (const rank of [null, 1, 2, 10, 28, 29, 50, 51, 200]) {
        expect(relevanceScore({ dense, sparseRank: rank })).toBe(
          legacyHybridSearch(dense, rank)
        );
      }
    }
  });

  it('un extrait trouvé seulement par mot-clé franchit le seuil par défaut', () => {
    // Le cas des archives : un nom propre dans un OCR, inconnu du modèle
    // d'embedding. Cosinus nul, mais BM25 le classe premier.
    expect(relevanceScore({ dense: 0, sparseRank: 1 })).toBeGreaterThan(0.12);
    expect(relevanceScore({ dense: 0, sparseRank: SPARSE_BOOST_RANK })).toBe(
      SPARSE_FLOOR
    );
  });

  it('garde le cosinus quand il est la meilleure preuve', () => {
    expect(relevanceScore({ dense: 0.82, sparseRank: 1 })).toBe(0.82);
  });

  it('ne donne rien à un rang absent ou hors borne', () => {
    expect(sparseRankRelevance(null)).toBe(0);
    expect(sparseRankRelevance(undefined)).toBe(0);
    expect(sparseRankRelevance(0)).toBe(0);
    expect(sparseRankRelevance(SPARSE_BOOST_RANK + 1)).toBe(0);
  });

  it('reste sur l’échelle du cosinus, loin des scores RRF', () => {
    // Le défaut d'origine : un RRF plafonne à 1/61 ≈ 0,016.
    expect(relevanceScore({ dense: 0, sparseRank: 1 })).toBeGreaterThan(1 / 61);
  });
});

describe('applyThreshold', () => {
  const hits = (...scores: number[]) => scores.map((similarity) => ({ similarity }));

  it('filtre sous le seuil', () => {
    expect(applyThreshold(hits(0.5, 0.2, 0.1), 0.12, 3)).toEqual(hits(0.5, 0.2));
  });

  it('garde les meilleurs extraits quand aucun ne franchit le seuil, si repli demandé', () => {
    const out = applyThreshold(hits(0.1, 0.09, 0.08, 0.07, 0.06), 0.12, CROSS_LANGUAGE_FALLBACK);
    expect(out).toEqual(hits(0.1, 0.09, 0.08));
  });

  it('se tait quand aucun extrait ne franchit le seuil et que le repli est nul', () => {
    expect(applyThreshold(hits(0.1, 0.09), 0.12, 0)).toEqual([]);
  });

  it('ne fabrique rien à partir d’une liste vide', () => {
    expect(applyThreshold([], 0.12, 3)).toEqual([]);
  });
});
