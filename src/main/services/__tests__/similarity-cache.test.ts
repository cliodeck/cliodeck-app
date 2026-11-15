/**
 * Le cache de similarité (S13-1-1, S13-1-3).
 *
 * Son empreinte du corpus lisait deux champs que `getStatistics` ne rend pas : elle valait toujours
 * la même chose, et des PDF indexés après une analyse n'apparaissaient pas avant 24 h. Sa clé ne
 * comparait que trois options sur sept : passer aux sources primaires, restreindre à une collection
 * ou couper le reclassement rendait les recommandations d'avant. Et `get-all-results`, appelé à
 * chaque ouverture du panneau, rendait l'analyse du dernier texte analysé, quel que soit le document
 * ouvert : dans un livre, les segments et les lignes du chapitre 3 sur le chapitre 5.
 *
 * Vrai service, vrai fichier de cache dans un projet temporaire. La recherche et l'état des corpus
 * sont simulés : ce qui compte ici, c'est quand le service cherche de nouveau, et ce qu'il rend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

interface PdfCorpus {
  documentCount: number;
  chunkCount: number;
  lastIndexedAt: string | null;
  rebuildDue: boolean;
}

interface PrimaryCorpus {
  sourceCount: number;
  chunkCount: number;
  lastIndexedAt: string | null;
  lastChunkId: string | null;
}

const h = vi.hoisted(() => ({
  projectPath: null as string | null,
  pdf: null as unknown as PdfCorpus,
  primary: null as PrimaryCorpus | null,
  /** Le magasin des PDF n'est pas ouvert : ses lectures lèvent, comme `ensureStore`. */
  unreadable: false,
  search: null as unknown as ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown[]>>>,
}));

vi.mock('../pdf-service.js', () => {
  const readable = (): void => {
    if (h.unreadable) throw new Error('pdf-service: vector store not initialized');
  };
  return {
    pdfService: {
      search: (...args: unknown[]) => h.search(...args),
      // Ce que rend le vrai magasin (`VectorStore.getStatistics`) : documentCount et chunkCount.
      getStatistics: async () => {
        readable();
        const { documentCount, chunkCount } = h.pdf;
        return { documentCount, chunkCount, embeddingCount: chunkCount, databasePath: '/brain.db' };
      },
      getIndexFreshness: () => {
        readable();
        return { ...h.pdf };
      },
    },
  };
});
vi.mock('../tropy-service.js', () => ({
  tropyService: { getIndexFreshness: () => (h.primary ? { ...h.primary } : null) },
}));
vi.mock('../project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));

import { similarityService, type SimilarityOptions } from '../similarity-service.js';

const BASE: Partial<SimilarityOptions> = {
  granularity: 'paragraph',
  useReranking: false,
  useContextualEmbedding: false,
  sourceType: 'secondary',
  collectionFilter: null,
};

const CHAPTER_1 = [
  '# Chapitre 1',
  '',
  'Le préfet Chiappe est muté au Maroc en février 1934, et la rue gronde.',
  '',
  'Les ligues se rassemblent place de la Concorde le soir du 6 février.',
  '',
  'La commission d’enquête siège tout le printemps sans rien conclure.',
].join('\n');

const CHAPTER_2 = [
  '# Chapitre 2',
  '',
  'Le Front populaire gagne les élections de mai 1936 contre toute attente.',
  '',
  'Les grèves de juin occupent les usines dans une atmosphère de fête.',
].join('\n');

let project = '';

const hit = (id: string) => ({
  sourceType: 'secondary',
  similarity: 0.5,
  document: { id, title: `Titre ${id}`, author: 'Berstein' },
  chunk: { content: `Extrait ${id}`, pageNumber: 1 },
});

const analyze = (text: string, options: Partial<SimilarityOptions> = {}) =>
  similarityService.analyzeDocument(text, { ...BASE, ...options });

const cachePath = () => path.join(project, '.cliodeck', 'similarity_cache.json');

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-similarite-cache-'));
  fs.mkdirSync(path.join(project, '.cliodeck'));
  h.projectPath = project;
  h.pdf = { documentCount: 1, chunkCount: 4, lastIndexedAt: '2026-11-14T09:00:00.000Z', rebuildDue: false };
  h.primary = { sourceCount: 2, chunkCount: 6, lastIndexedAt: '2026-11-10T08:00:00.000Z', lastChunkId: 'c-6' };
  h.unreadable = false;
  h.search = vi.fn(async () => [hit('pdf-a')]);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(project, { recursive: true, force: true });
});

/** Une analyse, puis la même : la seconde a-t-elle cherché de nouveau ? */
async function searchesAgainAfter(change: () => void, second: Partial<SimilarityOptions> = {}): Promise<boolean> {
  await analyze(CHAPTER_1);
  const before = h.search.mock.calls.length;
  change();
  await analyze(CHAPTER_1, second);
  return h.search.mock.calls.length > before;
}

describe('cache de similarité — le corpus change', () => {
  it('un PDF de plus : l’analyse cherche de nouveau', async () => {
    expect(await searchesAgainAfter(() => (h.pdf = { ...h.pdf, documentCount: 2, chunkCount: 9 }))).toBe(true);
  });

  it('autant de documents, mais un PDF réindexé (date neuve) : l’analyse cherche de nouveau', async () => {
    expect(await searchesAgainAfter(() => (h.pdf = { ...h.pdf, lastIndexedAt: '2026-11-15T07:00:00.000Z' }))).toBe(
      true
    );
  });

  it('témoin : rien n’a changé, le cache sert', async () => {
    expect(await searchesAgainAfter(() => undefined)).toBe(false);
  });

  it('sources primaires : leurs extraits réécrits (dernier extrait neuf) invalident le cache', async () => {
    await analyze(CHAPTER_1, { sourceType: 'primary' });
    const before = h.search.mock.calls.length;
    h.primary = { ...h.primary!, lastChunkId: 'c-6-neuf' };
    await analyze(CHAPTER_1, { sourceType: 'primary' });
    expect(h.search.mock.calls.length).toBeGreaterThan(before);
  });

  it('sources secondaires seules : un changement des sources primaires ne jette pas l’analyse', async () => {
    expect(await searchesAgainAfter(() => (h.primary = { ...h.primary!, lastChunkId: 'c-7' }))).toBe(false);
  });

  it('une reconstruction de l’index des PDF due pendant l’analyse : le cache ne survit pas à la reconstruction', async () => {
    h.pdf = { ...h.pdf, rebuildDue: true };
    expect(await searchesAgainAfter(() => (h.pdf = { ...h.pdf, rebuildDue: false }))).toBe(true);
  });

  it('corpus illisible : rien n’est servi du cache', async () => {
    h.unreadable = true;
    expect(await searchesAgainAfter(() => undefined)).toBe(true);
  });
});

describe('cache de similarité — les options', () => {
  it.each([
    ['sourceType', { sourceType: 'both' as const }],
    ['collectionFilter', { collectionFilter: ['GUERRE'] }],
    ['useReranking', { useReranking: true }],
    ['useContextualEmbedding', { useContextualEmbedding: true }],
  ])('%s changé : l’analyse cherche de nouveau', async (_name, changed) => {
    expect(await searchesAgainAfter(() => undefined, changed)).toBe(true);
  });

  it('témoin : mêmes options, le cache sert', async () => {
    expect(await searchesAgainAfter(() => undefined, { ...BASE })).toBe(false);
  });

  it('les mêmes collections dans un autre ordre : le cache sert', async () => {
    await analyze(CHAPTER_1, { collectionFilter: ['GUERRE', 'FRONT'] });
    const before = h.search.mock.calls.length;
    await analyze(CHAPTER_1, { collectionFilter: ['FRONT', 'GUERRE'] });
    expect(h.search.mock.calls.length).toBe(before);
  });
});

describe('cache de similarité — ce que rend la relecture, pour le document ouvert', () => {
  it('un autre chapitre : rien', async () => {
    await analyze(CHAPTER_1);
    expect(await similarityService.getAllCachedResults(CHAPTER_2)).toEqual([]);
  });

  it('le même chapitre : toute son analyse', async () => {
    const analysed = await analyze(CHAPTER_1);
    expect(await similarityService.getAllCachedResults(CHAPTER_1)).toEqual(analysed);
  });

  it('un paragraphe retouché et une ligne ajoutée en tête : les autres restent, à leurs lignes actuelles', async () => {
    const analysed = await analyze(CHAPTER_1);
    const edited = ['Une phrase ajoutée en tête.', '', CHAPTER_1.replace('sans rien conclure', 'et conclut')].join('\n');

    const reread = await similarityService.getAllCachedResults(edited);

    const kept = analysed.filter((r) => !r.segment.content.includes('commission'));
    expect(reread.map((r) => r.segmentId)).toEqual(kept.map((r) => r.segmentId));
    expect(reread.map((r) => r.segment.startLine)).toEqual(kept.map((r) => r.segment.startLine + 2));
  });

  it('le corpus a changé depuis l’analyse : rien', async () => {
    await analyze(CHAPTER_1);
    h.pdf = { ...h.pdf, documentCount: 2 };
    expect(await similarityService.getAllCachedResults(CHAPTER_1)).toEqual([]);
  });

  it('une analyse de plus de 24 h : rien', async () => {
    await analyze(CHAPTER_1);
    const cache = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    cache.createdAt = Date.now() - 25 * 60 * 60 * 1000;
    fs.writeFileSync(cachePath(), JSON.stringify(cache));
    expect(await similarityService.getAllCachedResults(CHAPTER_1)).toEqual([]);
  });

  it('sans texte : rien', async () => {
    await analyze(CHAPTER_1);
    expect(await similarityService.getAllCachedResults('')).toEqual([]);
  });

  it('un fichier CRLF analysé, relu en CRLF (getValue) ou en LF (getDocText) : mêmes segments, sans \\r', async () => {
    const crlf = CHAPTER_1.replace('rue gronde.', 'rue\ngronde.').split('\n').join('\r\n');
    const analysed = await analyze(crlf);

    for (const text of [crlf, crlf.split('\r\n').join('\n')]) {
      const reread = await similarityService.getAllCachedResults(text);
      expect(reread.map((r) => r.segmentId)).toEqual(analysed.map((r) => r.segmentId));
      expect(reread.some((r) => r.segment.content.includes('\r'))).toBe(false);
    }
  });
});

describe('cache de similarité — projet disparu pendant l’analyse', () => {
  it('le dossier du projet n’est pas recréé pour y écrire le cache', async () => {
    h.search = vi.fn(async () => {
      fs.rmSync(project, { recursive: true, force: true });
      return [hit('pdf-a')];
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await analyze(CHAPTER_1);

    expect(fs.existsSync(project)).toBe(false);
  });
});
