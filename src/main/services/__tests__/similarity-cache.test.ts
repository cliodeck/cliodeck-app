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
 * La relecture gardait tout segment dont le contenu figurait dans le cache : deux chapitres ont
 * presque toujours des intertitres en commun (« ## Introduction », « ## Conclusion », un astérisme),
 * et le chapitre jamais analysé s'affichait « 2 segments analysés, 0 recommandations », ou avec les
 * recommandations cherchées pour l'autre chapitre. Le cache est donc lié au document analysé.
 *
 * Avec un filtre de collections, l'empreinte ne voyait pas une appartenance changée par une
 * synchronisation Zotero, qui ne réindexe rien.
 *
 * Un changement de ce que le cache range (L11-3 : la similarité après reclassement, l'aperçu, le
 * découpage en phrases) ne change ni le texte, ni les options, ni les corpus : sans version du
 * contenu, un cache écrit avant restait servi jusqu'à 24 h, avec ses anciennes recommandations.
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
  /** Les documents de chaque collection Zotero, sous-collections comprises. */
  members: {} as Record<string, string[]>,
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
      // Comme le vrai : avec un filtre, les documents qu'il retient (`getDocumentIdsInCollections`).
      getIndexFreshness: (collectionKeys?: readonly string[] | null) => {
        readable();
        const collectionDocumentIds = collectionKeys?.length
          ? [...new Set(collectionKeys.flatMap((key) => h.members[key] ?? []))].sort()
          : null;
        return { ...h.pdf, collectionDocumentIds };
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

import { SIMILARITY_CACHE_VERSION, similarityService, type SimilarityOptions } from '../similarity-service.js';

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

/** Deux chapitres d'un livre : chacun son introduction, sa conclusion, son astérisme. */
const SHARED_1 = [
  '# Chapitre 1 : Le 6 février',
  '',
  '## Introduction',
  '',
  'Le préfet Chiappe est muté au Maroc en février 1934, et la rue gronde.',
  '',
  '## Sources et méthode de l’enquête',
  '',
  'Les rapports de police de la série F7 couvrent la nuit du 6 au 7 février.',
  '',
  '* * *',
  '',
  '## Conclusion',
  '',
  'La commission d’enquête siège tout le printemps sans rien conclure.',
].join('\n');

const SHARED_2 = [
  '# Chapitre 2 : Le Front populaire',
  '',
  '## Introduction',
  '',
  'Le Front populaire gagne les élections de mai 1936 contre toute attente.',
  '',
  '## Sources et méthode de l’enquête',
  '',
  'Les archives syndicales racontent les occupations d’usines de juin.',
  '',
  '* * *',
  '',
  '## Conclusion',
  '',
  'Les grèves de juin occupent les usines dans une atmosphère de fête.',
].join('\n');

let project = '';
/** Les fichiers des chapitres, dans le projet. */
const chapter = (n: number) => path.join(project, 'chapters', `0${n}.md`);

const hit = (id: string) => ({
  sourceType: 'secondary',
  similarity: 0.5,
  document: { id, title: `Titre ${id}`, author: 'Berstein' },
  chunk: { content: `Extrait ${id}`, pageNumber: 1 },
});

const analyze = (text: string, options: Partial<SimilarityOptions> = {}, documentPath: string | null = chapter(1)) =>
  similarityService.analyzeDocument(text, { ...BASE, ...options }, undefined, documentPath);

/** La relecture du panneau, pour le document ouvert (le chapitre 1 sauf mention). */
const reread = (text: string, documentPath: string | null = chapter(1)) =>
  similarityService.getAllCachedResults(text, documentPath);

const cachePath = () => path.join(project, '.cliodeck', 'similarity_cache.json');

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-similarite-cache-'));
  fs.mkdirSync(path.join(project, '.cliodeck'));
  fs.mkdirSync(path.join(project, 'chapters'));
  fs.writeFileSync(chapter(1), CHAPTER_1);
  fs.writeFileSync(chapter(2), CHAPTER_2);
  h.projectPath = project;
  h.members = {};
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
    expect(await reread(CHAPTER_2, chapter(2))).toEqual([]);
  });

  it('le même chapitre : toute son analyse', async () => {
    const analysed = await analyze(CHAPTER_1);
    expect(await reread(CHAPTER_1)).toEqual(analysed);
  });

  it('un paragraphe retouché et une ligne ajoutée en tête : les autres restent, à leurs lignes actuelles', async () => {
    const analysed = await analyze(CHAPTER_1);
    const edited = ['Une phrase ajoutée en tête.', '', CHAPTER_1.replace('sans rien conclure', 'et conclut')].join('\n');

    const found = await reread(edited);

    const kept = analysed.filter((r) => !r.segment.content.includes('commission'));
    expect(found.map((r) => r.segmentId)).toEqual(kept.map((r) => r.segmentId));
    expect(found.map((r) => r.segment.startLine)).toEqual(kept.map((r) => r.segment.startLine + 2));
  });

  it('le corpus a changé depuis l’analyse : rien', async () => {
    await analyze(CHAPTER_1);
    h.pdf = { ...h.pdf, documentCount: 2 };
    expect(await reread(CHAPTER_1)).toEqual([]);
  });

  it('une analyse de plus de 24 h : rien', async () => {
    await analyze(CHAPTER_1);
    const cache = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    cache.createdAt = Date.now() - 25 * 60 * 60 * 1000;
    fs.writeFileSync(cachePath(), JSON.stringify(cache));
    expect(await reread(CHAPTER_1)).toEqual([]);
  });

  it('sans texte : rien', async () => {
    await analyze(CHAPTER_1);
    expect(await reread('')).toEqual([]);
  });

  it('un fichier CRLF analysé, relu en CRLF (getValue) ou en LF (getDocText) : mêmes segments, sans \\r', async () => {
    const crlf = CHAPTER_1.replace('rue gronde.', 'rue\ngronde.').split('\n').join('\r\n');
    const analysed = await analyze(crlf);

    for (const text of [crlf, crlf.split('\r\n').join('\n')]) {
      const found = await reread(text);
      expect(found.map((r) => r.segmentId)).toEqual(analysed.map((r) => r.segmentId));
      expect(found.some((r) => r.segment.content.includes('\r'))).toBe(false);
    }
  });
});

describe('cache de similarité — le document analysé, pas seulement ses segments', () => {
  it('deux chapitres aux mêmes intertitres et au même astérisme : rien sur celui qui n’a pas été analysé', async () => {
    const analysed = await analyze(SHARED_1);
    // Témoin : l'analyse a bien rendu les intertitres communs, trop courts pour être cherchés ou non.
    expect(analysed.map((r) => r.segment.content)).toEqual(
      expect.arrayContaining(['## Introduction', '## Sources et méthode de l’enquête', '* * *', '## Conclusion'])
    );

    expect(await reread(SHARED_2, chapter(2))).toEqual([]);
  });

  it('le même chapitre, dont ne restent que des segments trop courts pour avoir été cherchés : rien', async () => {
    await analyze(SHARED_1);
    expect(await reread('## Introduction\n\n* * *\n\n## Conclusion')).toEqual([]);
  });

  it('le même chapitre retouché : ses intertitres restent avec ses paragraphes encore là', async () => {
    const analysed = await analyze(SHARED_1);
    const edited = SHARED_1.replace('sans rien conclure', 'et conclut en juillet');

    const found = await reread(edited);

    const kept = analysed.filter((r) => !r.segment.content.includes('commission'));
    expect(found.map((r) => r.segmentId)).toEqual(kept.map((r) => r.segmentId));
  });

  it('un autre fichier au texte identique (« Enregistrer sous ») : toute l’analyse revient', async () => {
    const analysed = await analyze(CHAPTER_1);
    expect(await reread(CHAPTER_1, path.join(project, 'chapters', '01-copie.md'))).toEqual(analysed);
  });

  it('un document sans nom : seul son texte exact le désigne', async () => {
    const analysed = await analyze(CHAPTER_1, {}, null);
    expect(await reread(CHAPTER_1, null)).toEqual(analysed);
    expect(await reread(`${CHAPTER_1}\n\nUne phrase de plus.`, null)).toEqual([]);
  });

  it('le dossier du projet renommé : le chapitre retouché retrouve son analyse (chemin rangé relatif au projet)', async () => {
    const analysed = await analyze(CHAPTER_1);
    const renamed = `${project}-renomme`;
    fs.renameSync(project, renamed);
    project = renamed;
    h.projectPath = renamed;

    const found = await reread(CHAPTER_1.replace('sans rien conclure', 'et conclut'));

    expect(found.map((r) => r.segmentId)).toEqual(
      analysed.filter((r) => !r.segment.content.includes('commission')).map((r) => r.segmentId)
    );
  });

  it('l’analyse du même texte pour un autre fichier ne cherche pas de nouveau', async () => {
    await analyze(CHAPTER_1);
    const before = h.search.mock.calls.length;
    await analyze(CHAPTER_1, {}, path.join(project, 'chapters', '01-copie.md'));
    expect(h.search.mock.calls.length).toBe(before);
  });
});

describe('cache de similarité — filtre de collections', () => {
  it('l’appartenance aux collections change (synchronisation Zotero, sans réindexation) : l’analyse cherche de nouveau', async () => {
    h.members = { GUERRE: ['pdf-a'] };
    await analyze(CHAPTER_1, { collectionFilter: ['GUERRE'] });
    const before = h.search.mock.calls.length;

    h.members = { GUERRE: ['pdf-a', 'pdf-b'] };
    await analyze(CHAPTER_1, { collectionFilter: ['GUERRE'] });

    expect(h.search.mock.calls.length).toBeGreaterThan(before);
  });

  it('…et la relecture ne rend plus l’ancienne analyse', async () => {
    h.members = { GUERRE: ['pdf-a'] };
    await analyze(CHAPTER_1, { collectionFilter: ['GUERRE'] });
    h.members = { GUERRE: [] };
    expect(await reread(CHAPTER_1)).toEqual([]);
  });

  it('témoin : sans filtre, une autre appartenance ne jette pas l’analyse', async () => {
    h.members = { GUERRE: ['pdf-a'] };
    expect(await searchesAgainAfter(() => (h.members = { GUERRE: ['pdf-a', 'pdf-b'] }))).toBe(false);
  });

  it('témoin : une autre collection change, celle du filtre non : le cache sert', async () => {
    h.members = { GUERRE: ['pdf-a'], FRONT: ['pdf-c'] };
    await analyze(CHAPTER_1, { collectionFilter: ['GUERRE'] });
    const before = h.search.mock.calls.length;
    h.members = { GUERRE: ['pdf-a'], FRONT: ['pdf-c', 'pdf-d'] };
    await analyze(CHAPTER_1, { collectionFilter: ['GUERRE'] });
    expect(h.search.mock.calls.length).toBe(before);
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

describe('cache de similarité — la version de son contenu (L11-3)', () => {
  /** Réécrit le cache de la dernière analyse avec une autre version ; `undefined` : sans version, comme avant L11-3. */
  const rewriteVersion = (version: number | undefined) => {
    const cache = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    if (version === undefined) delete cache.version;
    else cache.version = version;
    fs.writeFileSync(cachePath(), JSON.stringify(cache));
  };

  it.each([
    ['écrit avant L11-3, sans version', undefined],
    ['de la version précédente', SIMILARITY_CACHE_VERSION - 1],
  ])('un cache %s n’est pas servi à l’analyse', async (_name, version) => {
    expect(await searchesAgainAfter(() => rewriteVersion(version))).toBe(true);
  });

  it.each([
    ['écrit avant L11-3, sans version', undefined],
    ['de la version précédente', SIMILARITY_CACHE_VERSION - 1],
  ])('…ni rendu à la relecture (cache %s)', async (_name, version) => {
    await analyze(CHAPTER_1);
    rewriteVersion(version);
    expect(await reread(CHAPTER_1)).toEqual([]);
  });

  it('témoin : un cache réécrit à la version courante sert', async () => {
    expect(await searchesAgainAfter(() => rewriteVersion(SIMILARITY_CACHE_VERSION))).toBe(false);
  });
});
