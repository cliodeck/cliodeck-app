/**
 * Indexer un PDF, c'est tout ou rien (S03-1-0, S01-1-13, S01-1-14).
 *
 * L'indexeur enregistrait le document avant de calculer le moindre embedding, puis ses extraits un
 * à un, chacun dans sa propre écriture. Un arrêt de l'app pendant les embeddings laissait donc un
 * document sans extrait : le renderer le comptait « déjà indexé », « Indexer tous les PDF » ne le
 * reproposait plus, et aucune recherche ne le trouvait. Deux indexations du même fichier voyaient
 * chacune le document encore en cours de l'autre : la première à finir le fondait dans le sien, et
 * la seconde échouait sur « FOREIGN KEY constraint failed » après tous ses embeddings. Une écriture
 * SQLite en échec au milieu des extraits laissait une copie partielle, que le nettoyage du
 * démarrage préfère à la complète.
 *
 * Le vrai indexeur sur une vraie base, avec les deux stores : le simple, et celui de l'app (HNSW et
 * BM25). Seuls l'extraction et les embeddings sont simulés.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteAvailable } from '@backend/__tests__/helpers/native-guards';
import { VectorStore } from '../core/vector-store/VectorStore';
import { EnhancedVectorStore } from '../core/vector-store/EnhancedVectorStore';
import { PDFIndexer } from '../core/pdf/PDFIndexer';
import type { RAGConfig } from '../types/config';
import type { PDFMetadata } from '../types/pdf-document';

const FILE = '/projet/PDFs/Kansteiner_2022.pdf';
const META = { title: 'Digital Doping for Historians', author: 'Kansteiner, Wulf', year: '2022' };

// Deux citations à la manière d'un article : sans elles, « aucune citation écrite » ne prouverait rien.
const TEXT =
  'Digital history requires historians to reflect on the transformations their tools impose on sources (Hughes, 2025). ' +
  'Each software layer rewrites the source like a palimpsest, and the historian must document every layer carefully. ' +
  'Machine learning models trained on archives reproduce the silences of those archives unless corrected (Papert, 1980). ';

const extract = async () => ({
  pages: [
    { pageNumber: 1, text: TEXT.repeat(6) },
    { pageNumber: 2, text: TEXT.repeat(6) },
  ],
  metadata: {},
  title: META.title,
});

type Embed = (content: string) => Promise<Float32Array>;

/** 768 : la dimension par défaut de l'index HNSW d'un projet neuf, qui refuse toute autre taille. */
const embed: Embed = async (content) => {
  const v = new Float32Array(768);
  for (let i = 0; i < content.length; i++) v[i % 768] += content.charCodeAt(i) / 1000;
  return v;
};

const ollamaDown: Embed = async () => {
  throw new Error('Embedding failed: fetch failed (Ollama)');
};

/** Filtres coupés : le texte répété des tests donne alors plusieurs extraits. */
const RAW: Partial<RAGConfig> = { enablePreprocessing: false, enableQualityFiltering: false, enableDeduplication: false };

/** Des embeddings qui attendent qu'on les relâche, comme un Ollama lent. */
function heldEmbeddings() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const embedding: Embed = async (content) => {
    calls += 1;
    await gate;
    return embed(content);
  };
  return { embedding, release, started: () => calls > 0 };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(condition()).toBe(true);
}

const diskFull = () => Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });

interface StoreKind {
  name: string;
  open: (dir: string) => Promise<VectorStore | EnhancedVectorStore>;
  base: (store: VectorStore | EnhancedVectorStore) => VectorStore;
}

const kinds: StoreKind[] = [
  {
    name: 'store simple',
    open: async (dir) => new VectorStore(dir),
    base: (store) => store as VectorStore,
  },
  {
    name: 'store de l’app (HNSW, BM25)',
    open: async (dir) => {
      const store = new EnhancedVectorStore(dir);
      await store.initialize();
      return store;
    },
    base: (store) => (store as EnhancedVectorStore).getBaseStore(),
  },
];

describe.skipIf(!sqliteAvailable)('PDF : une indexation est tout ou rien', () => {
  describe.each(kinds)('$name', ({ open, base }) => {
    let dir: string;
    let store: VectorStore | EnhancedVectorStore;

    const indexer = (embedding: Embed = embed, ragConfig: Partial<RAGConfig> = {}) =>
      new PDFIndexer(store, embedding, 'cpuOptimized', undefined, false, ragConfig, extract);

    /** Ce que contient `brain.db` sur le disque, lu par une autre connexion : ce qu'un arrêt de l'app laisserait. */
    function onDisk(): { documents: number; chunks: number; citations: number } {
      const db = new Database(path.join(dir, '.cliodeck', 'brain.db'), { readonly: true });
      try {
        const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        return { documents: count('pdf_documents'), chunks: count('pdf_chunks'), citations: count('pdf_citations') };
      } finally {
        db.close();
      }
    }

    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-tout-ou-rien-'));
      store = await open(dir);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('Ollama arrêté : rien n’est écrit, et le passage suivant, Ollama relancé, indexe le PDF', async () => {
      await expect(indexer(ollamaDown).indexPDF(FILE, 'Kansteiner_2022', undefined, META)).rejects.toThrow(/Ollama/);

      expect(store.getStatistics()).toMatchObject({ documentCount: 0, chunkCount: 0 });
      expect(store.getTotalCitationsCount()).toBe(0);

      const document = await indexer().indexPDF(FILE, 'Kansteiner_2022', undefined, META);

      expect(store.getStatistics().documentCount).toBe(1);
      expect(store.getChunksForDocument(document.id).length).toBeGreaterThan(0);
      expect(store.getCitationsForDocument(document.id).length).toBeGreaterThan(0);
    });

    it('pendant les embeddings, la base ne contient rien de la passe : un arrêt de l’app à ce moment ne laisse aucun document sans extrait', async () => {
      const held = heldEmbeddings();
      const job = indexer(held.embedding).indexPDF(FILE, 'Kansteiner_2022', undefined, META);
      await until(held.started);

      expect(onDisk()).toEqual({ documents: 0, chunks: 0, citations: 0 });

      held.release();
      const document = await job;
      const written = onDisk();
      expect(written.documents).toBe(1);
      expect(written.chunks).toBe(store.getChunksForDocument(document.id).length);
      expect(written.chunks).toBeGreaterThan(0);
    });

    it('deux indexations du même fichier en parallèle : aucune erreur, un document et un seul jeu d’extraits', async () => {
      const first = heldEmbeddings();
      const second = heldEmbeddings();
      const firstJob = indexer(first.embedding).indexPDF(FILE, 'Kansteiner_2022', undefined, META);
      const secondJob = indexer(second.embedding).indexPDF(FILE, 'Kansteiner_2022', undefined, META);
      await until(() => first.started() && second.started());

      first.release();
      await firstJob;
      second.release();
      const kept = await secondJob;

      expect(store.getDocumentIdsByFilePath(FILE)).toEqual([kept.id]);
      expect(store.getStatistics().documentCount).toBe(1);
      const chunks = store.getAllChunksWithEmbeddings();
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((c) => c.chunk.documentId === kept.id)).toBe(true);
      // Un seul jeu : autant d'extraits qu'une indexation seule en écrit.
      expect(new Set(chunks.map((c) => c.chunk.chunkIndex)).size).toBe(chunks.length);
    });

    it('deux indexations du même fichier qui finissent ensemble : un document, ses extraits, aucune erreur', async () => {
      const first = heldEmbeddings();
      const second = heldEmbeddings();
      const jobs = [first, second].map((held) =>
        indexer(held.embedding).indexPDF(FILE, 'Kansteiner_2022', undefined, META)
      );
      await until(() => first.started() && second.started());

      first.release();
      second.release();
      const results = await Promise.allSettled(jobs);

      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const ids = store.getDocumentIdsByFilePath(FILE);
      expect(ids).toHaveLength(1);
      expect(store.getChunksForDocument(ids[0]).length).toBeGreaterThan(0);
      expect(store.getAllChunksWithEmbeddings().every((c) => c.chunk.documentId === ids[0])).toBe(true);
    });

    it('une écriture qui échoue au 3e extrait n’écrit ni document ni extrait : l’ancienne copie reste, et le nettoyage du démarrage la garde', async () => {
      const previous = await indexer(embed, RAW).indexPDF(FILE, 'Kansteiner_2022', undefined, META);
      const complete = store.getChunksForDocument(previous.id).length;
      expect(complete).toBeGreaterThanOrEqual(3);
      const saveChunk = base(store).saveChunk.bind(base(store));
      let writes = 0;
      vi.spyOn(base(store), 'saveChunk').mockImplementation((chunk, embedding, hash) => {
        writes += 1;
        if (writes === 3) throw diskFull();
        saveChunk(chunk, embedding, hash);
      });

      await expect(indexer(embed, RAW).indexPDF(FILE, 'Kansteiner_2022', undefined, META)).rejects.toThrow(/disk is full/);
      vi.restoreAllMocks();

      expect(store.getDocumentIdsByFilePath(FILE)).toEqual([previous.id]);
      expect(store.getStatistics()).toMatchObject({ documentCount: 1, chunkCount: complete });
      store.removeDuplicateDocuments();
      expect(store.getDocumentIdsByFilePath(FILE)).toEqual([previous.id]);
      expect(store.getChunksForDocument(previous.id)).toHaveLength(complete);
    });

    /*
     * Disque plein : l'écriture du 3e extrait échoue, et le retrait de la copie partielle aussi, car
     * une suppression écrit elle aussi (dans le WAL). Une copie partielle laissée là est celle que le
     * nettoyage du démarrage garde, la plus récente qui a des extraits : la complète y était fondue.
     */
    it('disque plein, retrait impossible lui aussi : aucune copie partielle, la complète survit au nettoyage du démarrage', async () => {
      const previous = await indexer(embed, RAW).indexPDF(FILE, 'Kansteiner_2022', undefined, META);
      const complete = store.getChunksForDocument(previous.id).length;
      const saveChunk = base(store).saveChunk.bind(base(store));
      let writes = 0;
      vi.spyOn(base(store), 'saveChunk').mockImplementation((chunk, embedding, hash) => {
        writes += 1;
        if (writes >= 3) throw diskFull();
        saveChunk(chunk, embedding, hash);
      });
      vi.spyOn(base(store), 'deleteDocument').mockImplementation(() => {
        throw diskFull();
      });

      await expect(indexer(embed, RAW).indexPDF(FILE, 'Kansteiner_2022', undefined, META)).rejects.toThrow(/disk is full/);
      // Place libérée, puis réouverture du projet.
      vi.restoreAllMocks();
      store.removeDuplicateDocuments();

      expect(store.getDocumentIdsByFilePath(FILE)).toEqual([previous.id]);
      expect(store.getChunksForDocument(previous.id)).toHaveLength(complete);
      expect(store.getStatistics().chunkCount).toBe(complete);
    });

    it('un PDF sans texte reste enregistré, sans extrait (#132)', async () => {
      const image = async () => ({
        pages: Array.from({ length: 3 }, (_, i) => ({ pageNumber: i + 1, text: '' })),
        metadata: {},
        title: 'Scan',
      });
      const document = await new PDFIndexer(store, embed, 'cpuOptimized', undefined, false, {}, image).indexPDF(
        '/projet/PDFs/Scan.pdf',
        'Scan_1935',
        undefined,
        META
      );

      expect(store.getDocument(document.id)?.metadata.textDensity).toEqual({ charsPerPage: 0, lowText: true });
      expect(store.getChunksForDocument(document.id)).toHaveLength(0);
    });

    /*
     * Un PDF de texte peut lui aussi finir sans aucun extrait : le filtre de qualité écarte ce qui
     * fait moins de 20 mots, une page d'inventaire par exemple. L'indexation est pourtant allée
     * au bout, et la refaire ne donnerait rien de plus. Sans marque, le renderer le confondait avec
     * le document vide qu'une indexation interrompue laissait avant l'écriture tout ou rien, et
     * « Indexer tous les PDF » le reproposait à chaque lot, en le comptant « indexé » à chaque fois.
     */
    it('un PDF de texte dont aucun extrait ne passe le filtre est enregistré, marqué indexé jusqu’au bout', async () => {
      // 16 mots, 119 caractères hors espaces : pas un PDF image (seuil à 100 par page).
      const shortText = async () => ({
        pages: [
          {
            pageNumber: 1,
            text: "Archives nationales, fonds Moscovici, carton 12, dossier 3 : correspondance administrative, rapports d'inspection, coupures de presse.",
          },
        ],
        metadata: {},
        title: 'Inventaire',
      });
      // Réglages de l'app : découpage adaptatif, filtre de qualité.
      const document = await new PDFIndexer(store, embed, 'cpuOptimized', undefined, true, {}, shortText).indexPDF(
        '/projet/PDFs/Inventaire_1932.pdf',
        'Inventaire_1932',
        undefined,
        { title: 'Inventaire', author: 'Anonyme', year: '1932' }
      );

      const saved = (store.getAllDocuments() as Array<{ id: string; chunkCount: number; metadata: PDFMetadata }>)
        .find((doc) => doc.id === document.id);
      expect(saved?.chunkCount).toBe(0);
      expect(saved?.metadata.textDensity?.lowText).toBe(false);
      expect(saved?.metadata.noChunks).toBe(true);
    });

    it('un PDF qui a ses extraits ne porte pas cette marque', async () => {
      const document = await indexer().indexPDF(FILE, 'Kansteiner_2022', undefined, META);

      expect(store.getChunksForDocument(document.id).length).toBeGreaterThan(0);
      expect(store.getDocument(document.id)?.metadata.noChunks).toBeUndefined();
    });

    /*
     * Les similarités se calculent après la transaction : le document est déjà complet en base. Un
     * échec à cette étape faisait échouer la passe, et le main sautait ce qui suit (collections
     * Zotero, #130) pour un document que le lot suivant compte indexé sans le reproposer.
     */
    it('le calcul des similarités échoue après l’écriture : la passe réussit, le document reste complet', async () => {
      vi.spyOn(base(store), 'computeAndSaveSimilarities').mockImplementation(() => {
        throw diskFull();
      });

      const document = await indexer().indexPDF(FILE, 'Kansteiner_2022', undefined, META);

      expect(store.getDocumentIdsByFilePath(FILE)).toEqual([document.id]);
      expect(store.getChunksForDocument(document.id).length).toBeGreaterThan(0);
    });
  });
});

/*
 * Les extraits sont écrits dans SQLite avant d'entrer dans HNSW et BM25, que l'on ne sait pas
 * écrire dans la même transaction, et qui ne savent pas retirer un vecteur. Si ces index ne les
 * prennent pas, la base garde le document complet : c'est la reconstruction, depuis SQLite, qui doit
 * les y mettre. De même pour les vecteurs d'une copie remplacée, que la recherche rendrait sinon.
 *
 * La passe réussit alors : un échec rendu au main lui faisait sauter le rattachement aux collections
 * Zotero (#130) et l'avertissement des PDF image (#132), pour un document que le lot suivant compte
 * indexé sans le reproposer (cf. src/main/services/__tests__/pdf-indexer-search-index-failure.test.ts).
 */
describe.skipIf(!sqliteAvailable)('PDF : HNSW et BM25 après l’écriture', () => {
  let dir: string;
  let store: EnhancedVectorStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-index-echec-'));
    store = new EnhancedVectorStore(dir);
    await store.initialize();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('l’index ne s’écrit pas : la passe réussit, le document reste complet en base, et une reconstruction est demandée', async () => {
    // Une écriture de l'index rendue impossible, comme sur un disque réel.
    fs.mkdirSync(path.join(dir, '.cliodeck', 'hnsw.index.meta.json.tmp'), { recursive: true });
    const indexer = new PDFIndexer(store, embed, 'cpuOptimized', undefined, false, {}, extract);

    const document = await indexer.indexPDF(FILE, 'Kansteiner_2022', undefined, META);

    expect(store.getDocumentIdsByFilePath(FILE)).toEqual([document.id]);
    expect(store.getChunksForDocument(document.id).length).toBeGreaterThan(0);
    expect(store.needsRebuild()).toBe(true);
  });

  it('un PDF image dont l’index ne s’écrit pas : la passe réussit, avec sa marque lowText (#132)', async () => {
    fs.mkdirSync(path.join(dir, '.cliodeck', 'hnsw.index.meta.json.tmp'), { recursive: true });
    const image = async () => ({
      pages: Array.from({ length: 3 }, (_, i) => ({ pageNumber: i + 1, text: '' })),
      metadata: {},
      title: 'Scan',
    });
    const indexer = new PDFIndexer(store, embed, 'cpuOptimized', undefined, false, {}, image);

    const document = await indexer.indexPDF('/projet/PDFs/Scan.pdf', 'Scan_1935', undefined, META);

    expect(document.metadata.textDensity?.lowText).toBe(true);
    expect(store.getDocumentIdsByFilePath('/projet/PDFs/Scan.pdf')).toEqual([document.id]);
  });

  it('une réindexation remplace l’ancienne copie dans la transaction, et demande une reconstruction pour ses vecteurs', async () => {
    const indexer = () => new PDFIndexer(store, embed, 'cpuOptimized', undefined, false, {}, extract);
    const previous = await indexer().indexPDF(FILE, 'Kansteiner_2022', undefined, META);
    expect(store.needsRebuild()).toBe(false);

    const replacement = await indexer().indexPDF(FILE, 'Kansteiner_2022', undefined, META);

    expect(store.getDocument(previous.id)).toBeNull();
    expect(store.getDocumentIdsByFilePath(FILE)).toEqual([replacement.id]);
    expect(store.needsRebuild()).toBe(true);
  });
});
