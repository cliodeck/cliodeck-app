/**
 * Bonus « mot-clé exact » de la fusion hybride (S01-2-0, L07-3).
 *
 * Avant L07-3, le bonus (score RRF doublé) se déclenchait sur une simple
 * sous-chaîne en minuscules, préfixe « [Doc: titre | Section: …] » compris :
 * « CIA » le donnait à « négociations sociales », et un titre « Histoire
 * sociale » le donnait à tous les extraits de l'ouvrage. Les écarts de RRF
 * étant minimes, un candidat dense de rang 41 doublé passait devant le premier,
 * et la coupe à `k` écartait les meilleurs résultats sémantiques.
 *
 * La jambe dense est imposée (rangs et cosinus fixés) : c'est l'entrée de la
 * fusion, pas ce que l'on vérifie. BM25 et la fusion sont ceux de l'app.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HybridSearch } from '../HybridSearch.js';
import { BM25Index } from '../BM25Index.js';
import type { HNSWVectorStore } from '../../vector-store/HNSWVectorStore.js';
import type { DocumentChunk, PDFDocument, SearchResult } from '../../../types/pdf-document.js';

const chunk = (id: string, content: string): DocumentChunk => ({
  id,
  documentId: 'doc',
  content,
  pageNumber: 1,
  chunkIndex: 0,
  startPosition: 0,
  endPosition: content.length,
});

/** Une jambe dense qui rend les extraits dans l'ordre donné, cosinus décroissant. */
const denseLeg = (chunks: DocumentChunk[]): HNSWVectorStore =>
  ({
    search: async (_embedding: Float32Array, k: number): Promise<SearchResult[]> =>
      chunks.slice(0, k).map((c, rank) => ({
        chunk: c,
        document: null as unknown as PDFDocument,
        similarity: 0.6 - rank * 0.005,
      })),
  }) as unknown as HNSWVectorStore;

const hybridOver = (dense: DocumentChunk[], lexical: DocumentChunk[]): HybridSearch => {
  const bm25 = new BM25Index();
  bm25.addChunks(lexical);
  const hybrid = new HybridSearch();
  hybrid.setHNSWStore(denseLeg(dense));
  hybrid.setBM25Index(bm25);
  return hybrid;
};

const rank = (id: string): number => Number(id.split('-')[1]);

/** Les rangs denses 1 à 40 parlent de l'Agence sans écrire le sigle ; 41 à 50 de négociations sociales. */
const agencyThenSocial = (): DocumentChunk[] =>
  Array.from({ length: 50 }, (_, i) =>
    i < 40
      ? chunk(
          `agence-${i + 1}`,
          `La Central Intelligence Agency finance des partis anticommunistes, dossier ${i + 1}.`
        )
      : chunk(
          `social-${i + 1}`,
          `Les négociations sociales de ${1900 + i} réunissent syndicats et patronat.`
        )
  );

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('HybridSearch — bonus « mot-clé exact »', () => {
  it('« CIA » ne favorise plus « sociales » : les meilleurs rangs denses restent en tête', async () => {
    const candidates = agencyThenSocial();
    const hybrid = hybridOver(candidates, candidates);
    const results = await hybrid.search('Rôle de la CIA', new Float32Array(1), 10);
    expect(results.map((r) => r.chunk.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `agence-${i + 1}`)
    );
    expect(results.every((r) => rank(r.chunk.id) <= 40)).toBe(true);
  });

  it('un extrait qui écrit le sigle comme mot entier garde le bonus', async () => {
    const candidates = agencyThenSocial();
    candidates[44] = chunk('cia-45', 'En 1954, la CIA organise le renversement du président Árbenz.');
    const hybrid = hybridOver(candidates, []);
    const results = await hybrid.search('Rôle de la CIA', new Float32Array(1), 10);
    expect(results[0].chunk.id).toBe('cia-45');
    expect(results.filter((r) => rank(r.chunk.id) > 40)).toHaveLength(1);
  });

  it('un titre « Histoire sociale » dans le préfixe ne donne aucun bonus', async () => {
    // Le titre est posé sur chaque extrait de l'ouvrage, quel qu'en soit le contenu.
    // Un titre qui contient des crochets : le préfixe s'arrête à la ligne vide, pas au premier « ] ».
    const header = '[Doc: Histoire sociale de la France [1789-1914] | Section: Syndicalisme]\n\n';
    const candidates = Array.from({ length: 50 }, (_, i) =>
      i < 40
        ? chunk(`houilleres-${i + 1}`, `Les houillères du Nord et la protection des mineurs, rapport ${i + 1}.`)
        : chunk(`ouvrage-${i + 1}`, `${header}Les grèves de ${1860 + i} dans le bassin houiller.`)
    );
    // BM25 vide : on ne mesure que le bonus, que le préfixe ne doit plus déclencher. BM25, lui,
    // indexe toujours le préfixe.
    const hybrid = hybridOver(candidates, []);

    for (const query of ['Rôle de la CIA', 'Histoire', 'Syndicalisme']) {
      const results = await hybrid.search(query, new Float32Array(1), 10);
      expect(results.map((r) => r.chunk.id)).toEqual(
        Array.from({ length: 10 }, (_, i) => `houilleres-${i + 1}`)
      );
    }
  });

  it('un mot de la question donne le bonus, écrit avec ou sans accent', async () => {
    const candidates = agencyThenSocial();
    candidates[45] = chunk('liege-46', 'Le congrès socialiste de Liège, en 1890.');
    const hybrid = hybridOver(candidates, []);

    const accented = await hybrid.search('congrès de Liège', new Float32Array(1), 10);
    expect(accented[0].chunk.id).toBe('liege-46');
    const unaccented = await hybrid.search('congres de Liege', new Float32Array(1), 10);
    expect(unaccented[0].chunk.id).toBe('liege-46');
  });

  it('un mot vide de cinq lettres ne vaut pas un bonus', async () => {
    const candidates = agencyThenSocial();
    candidates[46] = chunk('vide-47', 'Elles ont signé cette convention.');
    const results = await hybridOver(candidates, []).search('elles cette', new Float32Array(1), 10);
    expect(results.map((r) => r.chunk.id)).not.toContain('vide-47');
  });

  // La même question que « Rôle de la CIA », posée par un mot-outil de cinq lettres ou plus
  // (« Comment… », « Pendant… », « during », « während »). Ce mot ne doit valoir ni un bonus ni un
  // terme BM25 : sinon tout extrait qui l'écrit est doublé, et les rangs 41 à 50 évincent encore
  // les meilleurs résultats denses.
  it.each([
    [
      'Comment la CIA est-elle intervenue ?',
      'Comment, pendant ces années et depuis, quand les syndicats se divisent entre eux, comme après chaque crise, selon les régions.',
    ],
    [
      'Pendant la guerre froide, que fait la CIA ?',
      'Comment, pendant ces années et depuis, quand les syndicats se divisent entre eux, comme après chaque crise, selon les régions.',
    ],
    [
      'Quand la CIA intervient-elle ?',
      'Comment, pendant ces années et depuis, quand les syndicats se divisent entre eux, comme après chaque crise, selon les régions.',
    ],
    [
      'Quels étaient les objectifs de la CIA après 1945 ?',
      'Les syndicats étaient divisés, comme après chaque crise : quels accords, et pourquoi ?',
    ],
    [
      'What did the CIA do during the Cold War?',
      'Trade unions were divided between these years, while wages rose during the period.',
    ],
    [
      'Warum griff die CIA während des Kalten Krieges ein?',
      'Zwischen diesen Jahren, während die Löhne stiegen, wusste niemand warum.',
    ],
  ])('« %s » : le mot-outil de la question ne déplace pas les meilleurs rangs denses', async (query, distractor) => {
    const candidates = agencyThenSocial().map((c, i) =>
      i < 40 ? c : chunk(`autre-${i + 1}`, distractor)
    );
    const results = await hybridOver(candidates, candidates).search(query, new Float32Array(1), 10);
    expect(results.map((r) => r.chunk.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `agence-${i + 1}`)
    );
  });

  // Garde du contrat (Path A′), pas un test du défaut : il passait déjà avant L07-3.
  it('la pertinence publiée reste celle du contrat commun, le RRF ne sert qu’au tri', async () => {
    const candidates = agencyThenSocial();
    const hybrid = hybridOver(candidates, candidates);
    const results = await hybrid.search('Central Intelligence Agency', new Float32Array(1), 10);
    for (const r of results) {
      expect(r.similarity).toBeGreaterThanOrEqual(0.6 - 39 * 0.005);
      expect(r.similarity).toBeLessThanOrEqual(0.7);
    }
  });
});
