/**
 * Régressions du contrat de pertinence (Path A′).
 *
 *  1. Le vault publiait un score RRF (≤ 1/61 ≈ 0,016) face aux cosinus des
 *     autres corpus : ses notes passaient après tout le reste et
 *     n'obtenaient une place que s'il en restait.
 *  2. Tropy ramenait tout seuil au-dessus de 0,05 à 0,005 — conversion pensée
 *     pour des scores RRF que son store ne publie plus. Aucun extrait
 *     d'archive n'était filtré, et le repli gardait `topK` extraits quand
 *     aucun ne passait.
 *
 * Les stores sont remplacés par des doublures : ce qui est testé ici, c'est la
 * traduction de leurs signaux en pertinence et le seuil appliqué à chaque
 * corpus — pas la recherche SQLite elle-même.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retrievalService } from '../retrieval-service.js';
import { tropyService } from '../tropy-service.js';
import { configManager } from '../config-manager.js';
import { readingNotesIndexService } from '../reading-notes-index-service.js';

const THRESHOLD = 0.12;

interface Signals {
  dense: number;
  lexical: number;
  lexicalRank: number | null;
}

function vaultHit(id: string, signals: Signals) {
  return {
    chunk: { id, noteId: `note-${id}`, chunkIndex: 0, content: id, startPosition: 0, endPosition: 1 },
    note: { id: `note-${id}`, title: id, relativePath: `${id}.md` },
    // Le RRF, tel que le store le calcule : minuscule, et non comparable.
    score: 0.016,
    signals,
  };
}

function manuscriptHit(id: string, signals: Signals) {
  return {
    chunk: { id, chapterId: 'ch1', chunkIndex: 0, content: id, sectionTitle: 'S', line: 1 },
    chapter: { id: 'ch1', title: 'Chapitre 1', relativePath: 'chapters/01.md' },
    score: 0.016,
    signals,
  };
}

function readingNoteHit(id: string, signals: Signals) {
  return {
    chunk: { id, noteId: 'zotero:ABCD1234', chunkIndex: 0, content: id, line: 9 },
    note: {
      id: 'zotero:ABCD1234',
      relativePath: 'reading-notes/Braudel_1949.md',
      citekey: 'Braudel_1949',
      zoteroKey: 'ABCD1234',
      title: 'La Méditerranée',
      tags: ['chapitre-2'],
    },
    score: 0.016,
    signals,
  };
}

function secondaryHit(id: string, similarity: number) {
  return {
    chunk: { id, content: id, documentId: 'doc', chunkIndex: 0 },
    document: { id: 'doc', title: 'doc', author: null, bibtexKey: 'k' },
    similarity,
  };
}

type Internals = {
  ensureReady: () => void;
  inspectAndFilter: <T>(r: T[]) => { results: T[]; securityEvents: unknown[] };
  searchSecondary: (...args: unknown[]) => Promise<unknown[]>;
  getVaultStore: () => unknown;
  getManuscriptStore: () => unknown;
  getQueryEmbedding: (q: string) => Promise<Float32Array>;
};

describe('RetrievalService — contrat de pertinence des corpus', () => {
  const internals = retrievalService as unknown as Internals;

  beforeEach(() => {
    vi.spyOn(internals, 'ensureReady').mockImplementation(() => undefined);
    vi.spyOn(internals, 'inspectAndFilter').mockImplementation(<T,>(r: T[]) => ({
      results: r,
      securityEvents: [],
    }));
    vi.spyOn(internals, 'getQueryEmbedding').mockResolvedValue(new Float32Array([1, 0]));
    vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({
      topK: 5,
      similarityThreshold: THRESHOLD,
    } as ReturnType<typeof configManager.getRAGConfig>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('une note pertinente n’est plus évincée par une bibliographie qui sature', async () => {
    // Cinq places, cinq extraits de bibliographie honnêtes (cosinus 0,40–0,36),
    // et une note nettement plus pertinente (cosinus 0,55). Avant : la note
    // portait 0,016 et restait dehors.
    vi.spyOn(internals, 'searchSecondary').mockResolvedValue(
      [0.4, 0.39, 0.38, 0.37, 0.36].map((s, i) => secondaryHit(`pdf-${i}`, s))
    );
    vi.spyOn(internals, 'getVaultStore').mockReturnValue({
      search: () => [vaultHit('vichy', { dense: 0.55, lexical: 3, lexicalRank: 2 })],
    });

    const { hits } = await retrievalService.search({
      query: 'Vichy',
      sourceType: 'secondary',
      includeVault: true,
    });

    expect(hits).toHaveLength(5);
    expect(hits[0].sourceType).toBe('vault');
    expect(hits[0].similarity).toBeCloseTo(0.68); // rang lexical 2 → 0,68 > cosinus 0,55
  });

  it('une note trouvée seulement par mot-clé reçoit la pertinence de son rang', async () => {
    vi.spyOn(internals, 'getVaultStore').mockReturnValue({
      search: () => [vaultHit('kaqg', { dense: 0.02, lexical: 5, lexicalRank: 1 })],
    });

    const { hits } = await retrievalService.search({ query: 'KAQG', sourceType: 'vault' });

    expect(hits).toHaveLength(1);
    expect(hits[0].similarity).toBeCloseTo(0.7);
  });

  it('le vault se tait quand aucune note ne franchit le seuil (pas de repli)', async () => {
    vi.spyOn(internals, 'getVaultStore').mockReturnValue({
      search: () => [
        vaultHit('bruit-1', { dense: 0.05, lexical: 0, lexicalRank: null }),
        vaultHit('bruit-2', { dense: 0.04, lexical: 0, lexicalRank: null }),
      ],
    });

    const { hits, outcomes } = await retrievalService.search({ query: 'q', sourceType: 'vault' });

    expect(hits).toEqual([]);
    expect(outcomes.find((o) => o.source === 'vault')).toMatchObject({
      attempted: true,
      ok: true,
      hitCount: 0,
    });
  });

  it('le manuscrit ne réclame plus son quota avec des extraits hors sujet', async () => {
    vi.spyOn(internals, 'searchSecondary').mockResolvedValue(
      [0.5, 0.45, 0.4, 0.35, 0.3].map((s, i) => secondaryHit(`pdf-${i}`, s))
    );
    vi.spyOn(internals, 'getManuscriptStore').mockReturnValue({
      search: () => [manuscriptHit('hors-sujet', { dense: 0.03, lexical: 0, lexicalRank: null })],
    });

    const { hits, manuscriptHits } = await retrievalService.search({
      query: 'q',
      sourceType: 'secondary',
      includeManuscript: true,
    });

    expect(manuscriptHits).toEqual([]);
    expect(hits).toHaveLength(5);
  });

  it('un passage du manuscrit trouvé par mot-clé garde sa place', async () => {
    vi.spyOn(internals, 'getManuscriptStore').mockReturnValue({
      search: () => [manuscriptHit('passage', { dense: 0, lexical: 4, lexicalRank: 1 })],
    });

    const { manuscriptHits } = await retrievalService.search({
      query: 'Monnet',
      sourceType: 'manuscript',
    });

    expect(manuscriptHits).toHaveLength(1);
    expect(manuscriptHits[0].similarity).toBeCloseTo(0.7);
  });

  it('une note de lecture pertinente prend sa place, sans quota ni repli', async () => {
    vi.spyOn(internals, 'searchSecondary').mockResolvedValue(
      [0.5, 0.45, 0.4, 0.35, 0.3].map((s, i) => secondaryHit(`pdf-${i}`, s))
    );
    vi.spyOn(readingNotesIndexService, 'getSearchStore').mockReturnValue({
      search: () => [
        readingNoteHit('longue-duree', { dense: 0.2, lexical: 4, lexicalRank: 1 }),
        readingNoteHit('hors-sujet', { dense: 0.03, lexical: 0, lexicalRank: null }),
      ],
    } as unknown as ReturnType<typeof readingNotesIndexService.getSearchStore>);

    const { hits, readingNoteHits, outcomes } = await retrievalService.search({
      query: 'longue durée',
      sourceType: 'secondary',
      includeReadingNotes: true,
    });

    // Rang lexical 1 → 0,7 : elle devance la bibliographie et prend la
    // dernière place au mérite ; l'extrait hors sujet ne passe pas le seuil.
    expect(readingNoteHits).toHaveLength(1);
    expect(readingNoteHits[0].similarity).toBeCloseTo(0.7);
    expect(readingNoteHits[0].source).toMatchObject({ kind: 'reading-note', citekey: 'Braudel_1949', line: 9 });
    expect(hits).toHaveLength(4);
    expect(hits.every((h) => h.sourceType === 'secondary')).toBe(true);
    expect(outcomes.find((o) => o.source === 'readingNotes')).toMatchObject({ attempted: true, hitCount: 1 });
  });

  it('les notes de lecture ne sont jamais interrogées sans opt-in', async () => {
    const spy = vi.spyOn(readingNotesIndexService, 'getSearchStore');
    const { readingNoteHits } = await retrievalService.search({ query: 'q', sourceType: 'vault' });
    expect(readingNoteHits).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('tropyService.search — seuil sur l’échelle du cosinus', () => {
  type TropyInternals = { vectorStore: unknown; embedding: unknown };
  const tropy = tropyService as unknown as TropyInternals;
  let saved: TropyInternals;

  const primaryHit = (id: string, similarity: number) => ({
    chunk: { id, sourceId: 's', chunkIndex: 0, content: id },
    source: { id: 's', title: 'Procès-verbal' },
    similarity,
  });

  const withStoreResults = (results: ReturnType<typeof primaryHit>[]) => {
    tropy.vectorStore = {
      getIndexStats: () => ({ hnswSize: 1, bm25Size: 1, hnswDimension: 2 }),
      search: () => results,
    };
  };

  beforeEach(() => {
    saved = { vectorStore: tropy.vectorStore, embedding: tropy.embedding };
    tropy.embedding = { embed: async () => [[1, 0]] };
    vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({
      topK: 10,
      similarityThreshold: THRESHOLD,
    } as ReturnType<typeof configManager.getRAGConfig>);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    tropy.vectorStore = saved.vectorStore;
    tropy.embedding = saved.embedding;
    vi.restoreAllMocks();
  });

  it('filtre réellement les extraits sous le seuil', async () => {
    withStoreResults([primaryHit('a', 0.5), primaryHit('b', 0.3), primaryHit('c', 0.05)]);

    const out = await tropyService.search('q', { topK: 10, threshold: THRESHOLD });

    // Avant : le seuil devenait 0,005 et « c » passait.
    expect(out.map((r) => r.chunk.id)).toEqual(['a', 'b']);
  });

  it('replie sur trois extraits, pas sur topK, quand aucun ne franchit le seuil', async () => {
    withStoreResults(Array.from({ length: 12 }, (_, i) => primaryHit(`x${i}`, 0.05)));

    const out = await tropyService.search('q', { topK: 10, threshold: THRESHOLD });

    expect(out).toHaveLength(3);
  });
});
