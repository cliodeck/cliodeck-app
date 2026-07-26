/**
 * Régression : le corpus manuscrit était indexé à chaque sauvegarde mais
 * n'atteignait jamais l'assistant. Deux causes cumulées —
 *
 *  1. les extraits du manuscrit portaient un score RRF (max ≈ 0,016) là où
 *     les autres corpus portent un cosinus filtré à 0,12 ;
 *  2. le `slice(0, topK)` s'appliquait au tri global.
 *
 * Résultat : dès que la bibliographie rendait `topK` extraits, « qu'ai-je
 * déjà écrit sur X ? » restait sans réponse. Le point 1 est corrigé à la
 * source (on publie le cosinus réel) ; ces tests couvrent le point 2.
 */
import { describe, expect, it } from 'vitest';
import {
  MANUSCRIPT_QUOTA_RATIO,
  selectWithManuscriptQuota,
} from '../retrieval-quota.js';

interface Hit {
  id: string;
  similarity: number;
  sourceType: string;
}

const biblio = (n: number, base = 0.9): Hit[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `biblio-${i}`,
    similarity: base - i * 0.01,
    sourceType: 'secondary',
  }));

const manuscrit = (n: number, base = 0.4): Hit[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `manuscrit-${i}`,
    similarity: base - i * 0.01,
    sourceType: 'manuscript',
  }));

const kinds = (hits: Hit[]) => hits.map((h) => h.sourceType);

describe('selectWithManuscriptQuota', () => {
  it('réserve des places au manuscrit malgré une bibliographie qui sature', () => {
    // LE scénario du bug : 10 places, 20 extraits de bibliographie tous
    // mieux notés. Avant, le manuscrit n'en obtenait aucune.
    const out = selectWithManuscriptQuota([...biblio(20), ...manuscrit(5)], 10);

    expect(out).toHaveLength(10);
    expect(kinds(out).filter((k) => k === 'manuscript').length).toBeGreaterThan(0);
  });

  it('ne dépasse jamais le quota', () => {
    const out = selectWithManuscriptQuota([...biblio(20), ...manuscrit(20)], 10);
    const n = kinds(out).filter((k) => k === 'manuscript').length;

    expect(n).toBeLessThanOrEqual(Math.round(10 * MANUSCRIPT_QUOTA_RATIO));
    expect(out).toHaveLength(10);
  });

  it('ne prend aucune place quand le manuscrit ne renvoie rien', () => {
    const out = selectWithManuscriptQuota(biblio(20), 10);

    expect(out).toHaveLength(10);
    expect(kinds(out).every((k) => k === 'secondary')).toBe(true);
  });

  it('laisse le manuscrit prendre plus que son quota s’il gagne au mérite', () => {
    // Manuscrit très pertinent, bibliographie faible : le quota est un
    // plancher, pas un plafond déguisé.
    const out = selectWithManuscriptQuota(
      [...biblio(3, 0.2), ...manuscrit(10, 0.95)],
      10
    );

    expect(kinds(out).filter((k) => k === 'manuscript').length).toBeGreaterThan(3);
  });

  it('n’occupe pas toutes les places, même avec un topK minuscule', () => {
    const out = selectWithManuscriptQuota([...biblio(5), ...manuscrit(5)], 2);

    expect(out).toHaveLength(2);
    expect(kinds(out)).toContain('secondary');
  });

  it('ne rend pas plus d’extraits que le manuscrit n’en a produit', () => {
    const out = selectWithManuscriptQuota([...biblio(20), ...manuscrit(1)], 10);

    expect(kinds(out).filter((k) => k === 'manuscript')).toHaveLength(1);
    expect(out).toHaveLength(10);
  });

  it('rend les extraits triés par pertinence décroissante', () => {
    const out = selectWithManuscriptQuota([...biblio(10), ...manuscrit(5)], 8);
    const scores = out.map((h) => h.similarity);

    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('retrouve le comportement d’avant quand le ratio est nul', () => {
    const out = selectWithManuscriptQuota([...biblio(20), ...manuscrit(5)], 10, 0);

    expect(kinds(out).every((k) => k === 'secondary')).toBe(true);
  });

  it('ne rend rien pour un topK nul ou négatif', () => {
    expect(selectWithManuscriptQuota([...biblio(5), ...manuscrit(5)], 0)).toEqual([]);
    expect(selectWithManuscriptQuota([...biblio(5)], -3)).toEqual([]);
  });
});
