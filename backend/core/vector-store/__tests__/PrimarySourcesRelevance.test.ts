/**
 * Pertinence publiée par la recherche hybride des archives (Path A′).
 *
 * Un extrait trouvé seulement par BM25 — un nom propre dans un OCR, que le
 * modèle d'embedding ne connaît pas — portait `similarity: 0` (son cosinus
 * n'était pas calculé) et se classait derrière tout extrait sémantiquement
 * voisin. La fusion publie désormais le contrat commun :
 * max(cosinus, pertinence du rang lexical).
 *
 * La fusion est testée directement, sans base : elle ne lit SQLite que pour
 * rattacher sa source à un extrait lexical, ce que la doublure fournit.
 */
import { describe, expect, it } from 'vitest';
import { PrimarySourcesVectorStore } from '../PrimarySourcesVectorStore.js';
import { relevanceScore } from '../../rag/relevance.js';

type Fusion = (
  dense: unknown[],
  sparse: unknown[],
  k: number,
  originalQuery?: string
) => Array<{ chunk: { id: string }; similarity: number }>;

const source = { id: 'src', title: 'Procès-verbal du Comité des gouverneurs' };
const chunk = (id: string, content: string) => ({ id, sourceId: 'src', chunkIndex: 0, content });

function fuse(dense: unknown[], sparse: unknown[], k = 10, query?: string) {
  const fusion = (
    PrimarySourcesVectorStore.prototype as unknown as { reciprocalRankFusion: Fusion }
  ).reciprocalRankFusion;
  const fakeStore = { rrfK: 60, denseWeight: 0.6, sparseWeight: 0.4, getSource: () => source };
  return fusion.call(fakeStore, dense, sparse, k, query);
}

describe('PrimarySourcesVectorStore — pertinence de la fusion hybride', () => {
  it('un extrait trouvé seulement par mot-clé n’est plus noté 0', () => {
    const out = fuse(
      [{ chunk: chunk('semantique', 'politique monétaire européenne'), source, similarity: 0.41 }],
      [{ chunk: chunk('nom-propre', 'M. Zijlstra ouvre la séance'), score: 7.2 }]
    );
    const byId = Object.fromEntries(out.map((r) => [r.chunk.id, r.similarity]));

    expect(byId['nom-propre']).toBe(relevanceScore({ dense: 0, sparseRank: 1 }));
    expect(byId['nom-propre']).toBeGreaterThan(0.12);
    expect(byId['semantique']).toBeCloseTo(0.41);
  });

  it('garde le cosinus quand l’extrait n’a aucune preuve lexicale', () => {
    const out = fuse([{ chunk: chunk('a', 'texte'), source, similarity: 0.63 }], []);
    expect(out[0].similarity).toBeCloseTo(0.63);
  });

  it('retient la meilleure des deux preuves pour un extrait vu des deux côtés', () => {
    const shared = chunk('les-deux', 'Zijlstra et la politique monétaire');
    const out = fuse(
      [{ chunk: shared, source, similarity: 0.3 }],
      [{ chunk: shared, score: 5 }]
    );
    expect(out[0].similarity).toBe(relevanceScore({ dense: 0.3, sparseRank: 1 }));
  });
});
