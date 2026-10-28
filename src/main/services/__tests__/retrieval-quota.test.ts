/**
 * Deux régressions encadrent cette sélection.
 *
 * rc.4 : le manuscrit était indexé à chaque sauvegarde mais n'atteignait
 * jamais l'assistant — ses extraits portaient un score RRF (max ≈ 0,016) là
 * où les autres corpus portent un cosinus, et le `slice(0, topK)` du tri
 * global l'éliminait dès que la bibliographie saturait. Le premier point est
 * corrigé à la source (on publie le cosinus réel) ; la réserve de places
 * couvre le second.
 *
 * 2026-10 : la réserve était un plancher sans plafond, et le manuscrit —
 * écrit dans la langue de la question — gagnait les autres places au mérite
 * jusqu'à être seul dans le prompt (`docs/poids-du-manuscrit.md`). La
 * réserve est désormais une bande : au plus `slots` places, jamais une de
 * plus.
 */
import { describe, expect, it } from 'vitest';
import {
  MANUSCRIPT_QUOTA_RATIO,
  manuscriptSlots,
  selectWithManuscriptQuota,
  selectWithOwnTextBands,
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
const ownCount = (hits: Hit[]) => kinds(hits).filter((k) => k === 'manuscript').length;

describe('manuscriptSlots', () => {
  it('accorde une part des places, au moins une, jamais toutes', () => {
    expect(manuscriptSlots(10)).toBe(Math.round(10 * MANUSCRIPT_QUOTA_RATIO));
    expect(manuscriptSlots(20)).toBe(4);
    expect(manuscriptSlots(2)).toBe(1);
    expect(manuscriptSlots(3)).toBe(1);
  });

  it('ne donne rien quand il n’y a qu’une place, ou quand le ratio est nul', () => {
    // Une seule place : elle va aux sources. Avant, `max(1, …)` la donnait
    // au manuscrit — 100 % du contexte.
    expect(manuscriptSlots(1)).toBe(0);
    expect(manuscriptSlots(0)).toBe(0);
    expect(manuscriptSlots(10, 0)).toBe(0);
  });
});

describe('selectWithManuscriptQuota', () => {
  it('réserve des places au manuscrit malgré une bibliographie qui sature (garde-fou rc.4)', () => {
    // LE scénario du bug d'origine : 10 places, 20 extraits de bibliographie
    // tous mieux notés. Avant rc.4, le manuscrit n'en obtenait aucune.
    const out = selectWithManuscriptQuota([...biblio(20), ...manuscrit(5)], 10);

    expect(out).toHaveLength(10);
    expect(ownCount(out)).toBe(manuscriptSlots(10));
  });

  it('ne dépasse jamais sa bande, même quand il gagnerait au mérite', () => {
    // Manuscrit très pertinent, bibliographie moyenne : avant, le manuscrit
    // prenait la réserve PUIS les autres places au mérite.
    const out = selectWithManuscriptQuota([...biblio(20, 0.5), ...manuscrit(20, 0.95)], 10);

    expect(out).toHaveLength(10);
    expect(ownCount(out)).toBe(manuscriptSlots(10));
  });

  it('ne remplit pas les places que des sources faibles laissent vides', () => {
    // Le pire cas réel : trois extraits de repli cross-langue sous le seuil
    // contre dix passages du manuscrit dans la langue de la question. Avant :
    // dix passages du manuscrit, zéro source, en-tête « aucun extrait des
    // sources ». Maintenant : les trois sources et la bande, rien de plus.
    const out = selectWithManuscriptQuota([...biblio(3, 0.1), ...manuscrit(10, 0.45)], 10);

    expect(kinds(out).filter((k) => k === 'secondary')).toHaveLength(3);
    expect(ownCount(out)).toBe(manuscriptSlots(10));
    expect(out).toHaveLength(3 + manuscriptSlots(10));
  });

  it('ne prend aucune place quand le manuscrit ne renvoie rien', () => {
    const out = selectWithManuscriptQuota(biblio(20), 10);

    expect(out).toHaveLength(10);
    expect(kinds(out).every((k) => k === 'secondary')).toBe(true);
  });

  it('laisse la seule place aux sources quand topK vaut 1', () => {
    const out = selectWithManuscriptQuota([...biblio(5), ...manuscrit(5, 0.99)], 1);

    expect(out).toHaveLength(1);
    expect(kinds(out)).toEqual(['secondary']);
  });

  it('n’occupe pas toutes les places, même avec un topK minuscule', () => {
    const out = selectWithManuscriptQuota([...biblio(5), ...manuscrit(5)], 2);

    expect(out).toHaveLength(2);
    expect(kinds(out)).toContain('secondary');
  });

  it('ne rend pas plus d’extraits que le manuscrit n’en a produit', () => {
    const out = selectWithManuscriptQuota([...biblio(20), ...manuscrit(1)], 10);

    expect(ownCount(out)).toBe(1);
    expect(out).toHaveLength(10);
  });

  it('rend les extraits triés par pertinence décroissante', () => {
    const out = selectWithManuscriptQuota([...biblio(10), ...manuscrit(5)], 8);
    const scores = out.map((h) => h.similarity);

    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('suit la bande que l’appelant impose : élargie pour une question de rappel, nulle pour l’écarter', () => {
    const pool = [...biblio(20), ...manuscrit(20)];

    expect(ownCount(selectWithManuscriptQuota(pool, 10, 6))).toBe(6);
    // Portée « manuscrit seul » : toute la place, s'il y a de quoi.
    expect(kinds(selectWithManuscriptQuota(pool, 10, 10)).every((k) => k === 'manuscript')).toBe(
      true
    );
    expect(ownCount(selectWithManuscriptQuota(pool, 10, 0))).toBe(0);
    expect(selectWithManuscriptQuota(pool, 10, 0)).toHaveLength(10);
  });

  it('ne rend rien pour un topK nul ou négatif', () => {
    expect(selectWithManuscriptQuota([...biblio(5), ...manuscrit(5)], 0)).toEqual([]);
    expect(selectWithManuscriptQuota([...biblio(5)], -3)).toEqual([]);
  });
});

describe('selectWithOwnTextBands — les notes de lecture ont leur bande, comme le manuscrit', () => {
  const notes = (n: number, base = 0.95): Hit[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `note-${i}`,
      similarity: base - i * 0.01,
      sourceType: 'readingNotes',
    }));
  const count = (hits: Hit[], type: string) => kinds(hits).filter((k) => k === type).length;

  it('ne laisse plus les notes rafler les places au mérite', () => {
    // Avant : « à armes égales » — dix notes mieux notées que la bibliographie
    // prenaient les dix places.
    const out = selectWithOwnTextBands([...biblio(20, 0.5), ...notes(20)], 10);
    expect(count(out, 'readingNotes')).toBe(manuscriptSlots(10));
    expect(count(out, 'secondary')).toBe(10 - manuscriptSlots(10));
  });

  it('leur garantit leur bande quand la bibliographie sature (le défaut rc.4, côté notes)', () => {
    const out = selectWithOwnTextBands([...biblio(20), ...notes(5, 0.4)], 10);
    expect(count(out, 'readingNotes')).toBe(manuscriptSlots(10));
  });

  it('bande par corpus : manuscrit et notes chacun la leur, le reste aux sources', () => {
    const out = selectWithOwnTextBands([...biblio(20), ...manuscrit(5), ...notes(5)], 10, {
      manuscript: 3,
      readingNotes: 1,
    });
    expect(count(out, 'manuscript')).toBe(3);
    expect(count(out, 'readingNotes')).toBe(1);
    expect(count(out, 'secondary')).toBe(6);
  });

  it('deux portées « seul » qui débordent : les plus pertinents l’emportent entre eux', () => {
    const out = selectWithOwnTextBands([...manuscrit(10, 0.5), ...notes(10, 0.9)], 10, {
      manuscript: 10,
      readingNotes: 10,
    });
    expect(out).toHaveLength(10);
    expect(count(out, 'readingNotes')).toBe(10);
  });

  it('une bande nulle écarte le corpus', () => {
    const out = selectWithOwnTextBands([...biblio(5), ...notes(5)], 10, { readingNotes: 0 });
    expect(count(out, 'readingNotes')).toBe(0);
  });
});
