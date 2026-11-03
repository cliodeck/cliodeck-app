/**
 * Une reconstruction des index a un état terminal, réussie ou non.
 *
 * L'échec publiait `{ current: 0, status: 'Error: …' }`, soit 0 %, et le renderer
 * en déduisait qu'elle commençait : un voile plein écran sans bouton, qui ne partait
 * plus. Ici le vrai store sur une vraie base, et une écriture rendue impossible comme
 * sur un disque réel : un répertoire à l'emplacement du fichier temporaire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import type { DocumentChunk, PDFDocument } from '../../../types/pdf-document.js';
import type { RebuildProgressEvent } from '../../../types/rebuild-progress.js';
import { PdfVectorStore } from '../../../../src/main/services/pdf/PdfVectorStore.js';
import { EnhancedVectorStore } from '../EnhancedVectorStore.js';
import { VectorStore } from '../VectorStore.js';

let project = '';

const documentOf = (documentId: string): PDFDocument => {
  const now = new Date();
  return {
    id: documentId,
    fileURL: path.join(project, `${documentId}.pdf`),
    title: 'A',
    pageCount: 3,
    metadata: {},
    createdAt: now,
    indexedAt: now,
    lastAccessedAt: now,
    displayString: 'A',
  } as PDFDocument;
};

const chunkOf = (documentId: string, i: number): DocumentChunk => ({
  id: `${documentId}-c${i}`,
  documentId,
  content: `Extrait ${i} sur les archives.`,
  pageNumber: 1,
  chunkIndex: i,
  startPosition: 0,
  endPosition: 10,
});

const embeddingOf = (i: number): Float32Array =>
  new Float32Array(768).map((_, j) => Math.sin(i * 7 + j));

/** Un corpus déjà indexé dans brain.db, sans index HNSW sur le disque. */
function seedChunks(count: number, documentId = 'doc1'): void {
  const store = new VectorStore(project);
  store.saveDocument(documentOf(documentId));
  for (let i = 0; i < count; i += 1) {
    store.saveChunk(chunkOf(documentId, i), embeddingOf(i));
  }
  store.close();
}

/** Ce que fait `PDFIndexer` pour un PDF, sur le store ouvert. */
async function indexDocument(store: EnhancedVectorStore, documentId: string, count: number): Promise<void> {
  store.saveDocument(documentOf(documentId));
  await store.addChunks(
    Array.from({ length: count }, (_, i) => ({
      chunk: chunkOf(documentId, i),
      // Des vecteurs à eux, distincts de ceux du corpus déjà là.
      embedding: embeddingOf(i + 100),
    }))
  );
}

const hnswSize = async (store: EnhancedVectorStore) => (await store.getStats()).hnsw.currentSize;

/** Les documents des extraits les plus proches, par le sens seulement, d'un extrait du corpus. */
async function denseHitDocuments(store: EnhancedVectorStore, chunkId: string): Promise<string[]> {
  const stored = store.getAllChunksWithEmbeddings().find((entry) => entry.chunk.id === chunkId);
  store.setUseHybrid(false);
  const hits = await store.search('sans rapport', stored.embedding, 3);
  return hits.map((hit) => hit.chunk.documentId);
}

const cliodeck = (file: string) => path.join(project, '.cliodeck', file);

/** Une écriture de l'index rendue impossible, comme sur un disque réel. */
const blockIndexWrite = () => fs.mkdirSync(cliodeck('hnsw.index.meta.json.tmp'));

const failures = (events: RebuildProgressEvent[]) => events.filter((e) => e.phase === 'failed');

function openStore(): { store: EnhancedVectorStore; events: RebuildProgressEvent[] } {
  const store = new EnhancedVectorStore(project);
  const events: RebuildProgressEvent[] = [];
  store.setRebuildProgressCallback((event) => events.push(event));
  return { store, events };
}

describe.skipIf(!sqliteAvailable)('EnhancedVectorStore : la reconstruction se termine', () => {
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-reconstruction-'));
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('écriture impossible : le dernier événement est un échec, avec sa cause, là où elle s’est arrêtée', async () => {
    seedChunks(12);
    blockIndexWrite();
    const { store, events } = openStore();

    await expect(store.rebuildIndexes()).rejects.toThrow('Failed to save HNSW index');
    store.close();

    const last = events.at(-1);
    expect(last?.phase).toBe('failed');
    expect(last?.error).toMatch(/Failed to save HNSW index/);
    // Le pourcentage de l'échec n'est plus 0 : il disait « ça commence ».
    expect(last?.percentage).toBe(90);
    expect(events.slice(0, -1).map((e) => e.phase)).toEqual(events.slice(0, -1).map(() => 'running'));
  });

  it('sans ce répertoire : le dernier événement est un succès, à 100 %, sans erreur', async () => {
    seedChunks(12);
    const { store, events } = openStore();

    await store.rebuildIndexes();
    store.close();

    const last = events.at(-1);
    expect(last?.phase).toBe('done');
    expect(last?.percentage).toBe(100);
    expect(last?.error).toBeUndefined();
    expect(events.slice(0, -1).map((e) => e.phase)).toEqual(events.slice(0, -1).map(() => 'running'));
    expect(fs.existsSync(cliodeck('hnsw.index'))).toBe(true);
  });

  it('rien à indexer : l’autre sortie à 100 % est un succès aussi', async () => {
    const { store, events } = openStore();

    await store.rebuildIndexes();
    store.close();

    expect(events.at(-1)?.phase).toBe('done');
    expect(events.at(-1)?.percentage).toBe(100);
  });

  it('à l’ouverture du projet : l’échec est dit, et l’ouverture continue', async () => {
    seedChunks(12);
    blockIndexWrite();
    const { store, events } = openStore();

    await expect(store.initialize()).resolves.toBeUndefined();

    expect(events.at(-1)?.phase).toBe('failed');
    // La recherche garde l'index en mémoire.
    expect((await store.getStats()).hnsw.currentSize).toBe(12);
    store.close();
  });

  describe('le message promet la prochaine ouverture : rien ne repart avant', () => {
    it('après un échec à l’ouverture, le préchauffage ne relance rien : un seul message', async () => {
      seedChunks(12);
      blockIndexWrite();
      const { store, events } = openStore();
      await store.initialize();
      const seen = events.length;

      // Ce que fait `pdf-service` une fois le modèle d'embeddings préchauffé. Relancé,
      // le voile revenait sur l'auteur qui s'était remis à écrire, sans qu'il ait rien fait.
      expect(store.needsRebuild()).toBe(false);
      await PdfVectorStore.maybeRebuild(store);

      expect(events.length).toBe(seen);
      expect(failures(events)).toHaveLength(1);
      store.close();
    });

    it('même quand l’échec a laissé l’index en mémoire vide', async () => {
      seedChunks(12);
      // `clear()` ne peut pas supprimer un répertoire : l'échec survient avant le remplissage.
      fs.mkdirSync(cliodeck('hnsw.index'));
      const { store, events } = openStore();
      await store.initialize();

      expect(events.at(-1)?.phase).toBe('failed');
      expect((await store.getStats()).hnsw.currentSize).toBe(0);
      const seen = events.length;

      await PdfVectorStore.maybeRebuild(store);

      expect(events.length).toBe(seen);
      store.close();
    });

    it('elle repart à la prochaine ouverture, et réussit une fois la cause partie', async () => {
      seedChunks(12);
      blockIndexWrite();
      const first = openStore();
      await first.store.initialize();
      first.store.close();

      const second = openStore();
      await second.store.initialize();
      second.store.close();
      expect(failures(second.events)).toHaveLength(1);

      fs.rmdirSync(cliodeck('hnsw.index.meta.json.tmp'));
      const third = openStore();
      await third.store.initialize();

      expect(third.events.at(-1)?.phase).toBe('done');
      expect(fs.existsSync(cliodeck('hnsw.index'))).toBe(true);
      expect(third.store.needsRebuild()).toBe(false);
      third.store.close();
    });

    it('des documents quittent SQLite après l’échec : c’est un nouveau motif, elle repart', async () => {
      seedChunks(6, 'doc1');
      seedChunks(6, 'doc2');
      blockIndexWrite();
      const { store, events } = openStore();
      await store.initialize();
      expect(failures(events)).toHaveLength(1);

      store.deleteDocument('doc2');
      expect(store.needsRebuild()).toBe(true);
      await PdfVectorStore.maybeRebuild(store);

      expect(failures(events)).toHaveLength(2);
      // Et le nouvel échec ne relance rien non plus.
      expect(store.needsRebuild()).toBe(false);
      store.close();
    });

    it('une réussite efface l’échec : le manque suivant se voit de nouveau', async () => {
      seedChunks(6);
      blockIndexWrite();
      const { store } = openStore();
      await store.initialize();
      fs.rmdirSync(cliodeck('hnsw.index.meta.json.tmp'));

      await store.rebuildIndexes();
      await store.clear();

      expect(store.needsRebuild()).toBe(true);
      store.close();
    });
  });

  describe('échec avant le remplissage : un PDF indexé ensuite ne remplace pas le corpus', () => {
    /**
     * `clear()` ne peut pas supprimer un répertoire : l'échec survient avant de lire
     * SQLite, l'index en mémoire reste vide. La cause part ensuite d'elle-même.
     */
    async function failBeforeFilling(): Promise<ReturnType<typeof openStore>> {
      fs.mkdirSync(cliodeck('hnsw.index'));
      const opened = openStore();
      await opened.store.initialize();
      expect(failures(opened.events)).toHaveLength(1);
      expect(await hnswSize(opened.store)).toBe(0);
      fs.rmdirSync(cliodeck('hnsw.index'));
      return opened;
    }

    /** La prochaine ouverture, préchauffage compris. */
    async function reopen(): Promise<ReturnType<typeof openStore>> {
      const next = openStore();
      await next.store.initialize();
      await PdfVectorStore.maybeRebuild(next.store);
      return next;
    }

    it('la reconstruction planifiée après l’indexation refait tout le corpus, et il reste à la réouverture', async () => {
      seedChunks(12);
      const { store, events } = await failBeforeFilling();

      await indexDocument(store, 'doc2', 3);

      // De nouveaux extraits sur un index incomplet : c'est un nouveau motif.
      expect(store.needsRebuild()).toBe(true);
      await PdfVectorStore.maybeRebuild(store);
      expect(events.at(-1)?.phase).toBe('done');
      expect(await hnswSize(store)).toBe(15);
      store.close();

      const next = await reopen();
      expect(next.events).toEqual([]);
      expect(await hnswSize(next.store)).toBe(15);
      expect(await denseHitDocuments(next.store, 'doc1-c0')).toContain('doc1');
      next.store.close();
    });

    it('l’auteur quitte avant cette reconstruction : rien d’incomplet sur le disque, la prochaine ouverture refait tout', async () => {
      seedChunks(12);
      const { store } = await failBeforeFilling();

      await indexDocument(store, 'doc2', 3);

      // Écrit ici, l'index de ces 3 extraits passait pour complet à la réouverture :
      // non vide, métadonnées lisibles, donc aucune reconstruction ni aucun message.
      expect(fs.existsSync(cliodeck('hnsw.index'))).toBe(false);
      expect(fs.existsSync(cliodeck('hnsw.index.meta.json'))).toBe(false);
      store.close();

      const next = await reopen();
      expect(next.events.at(-1)?.phase).toBe('done');
      expect(await hnswSize(next.store)).toBe(15);
      next.store.close();
    });

    it('lecture SQLite en erreur : même chose, l’index du disque a déjà été retiré', async () => {
      seedChunks(12);
      const { store, events } = openStore();
      await store.initialize();
      vi.spyOn(store.getBaseStore(), 'getAllChunksWithEmbeddings').mockImplementationOnce(() => {
        throw new Error('database disk image is malformed');
      });
      await expect(store.rebuildIndexes()).rejects.toThrow('malformed');
      expect(events.at(-1)?.phase).toBe('failed');

      await indexDocument(store, 'doc2', 3);

      expect(fs.existsSync(cliodeck('hnsw.index'))).toBe(false);
      expect(store.needsRebuild()).toBe(true);
      await PdfVectorStore.maybeRebuild(store);
      expect(await hnswSize(store)).toBe(15);
      store.close();
    });

    // chmod ne retire pas ce droit sous Windows, ni à root : le vrai disque en refuserait
    // le test, pas le code.
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'suppression refusée : l’ancien index reste en place jusqu’à ce que le nouveau soit complet',
      async () => {
        seedChunks(6, 'doc1');
        seedChunks(6, 'doc2');
        const { store, events } = openStore();
        await store.initialize();
        const previous = fs.readFileSync(cliodeck('hnsw.index'));
        store.deleteDocument('doc2');

        const directory = path.join(project, '.cliodeck');
        fs.chmodSync(directory, 0o555);
        try {
          await PdfVectorStore.maybeRebuild(store);
        } finally {
          fs.chmodSync(directory, 0o755);
        }
        expect(failures(events)).toHaveLength(1);

        await indexDocument(store, 'doc3', 3);

        expect(fs.readFileSync(cliodeck('hnsw.index')).equals(previous)).toBe(true);
        await PdfVectorStore.maybeRebuild(store);
        store.close();

        const next = await reopen();
        expect(next.events).toEqual([]);
        expect(await hnswSize(next.store)).toBe(9);
        expect(await denseHitDocuments(next.store, 'doc1-c0')).toContain('doc1');
        next.store.close();
      }
    );

    it('addChunk, l’entrée à l’unité, compte aussi comme de nouveaux extraits', async () => {
      seedChunks(12);
      const { store } = await failBeforeFilling();
      store.saveDocument(documentOf('doc2'));

      await store.addChunk(chunkOf('doc2', 0), embeddingOf(0));

      expect(store.needsRebuild()).toBe(true);
      store.close();
    });

    it('sans nouvel extrait, rien ne repart : le message a promis la prochaine ouverture', async () => {
      seedChunks(12);
      const { store, events } = await failBeforeFilling();
      const seen = events.length;

      expect(store.needsRebuild()).toBe(false);
      await PdfVectorStore.maybeRebuild(store);

      expect(events.length).toBe(seen);
      store.close();
    });

    it('une reconstruction réussie entre-temps : l’index est de nouveau complet, un PDF s’y ajoute et s’écrit', async () => {
      seedChunks(12);
      const { store, events } = await failBeforeFilling();
      await store.rebuildIndexes();
      const seen = events.length;

      await indexDocument(store, 'doc2', 3);

      expect(store.needsRebuild()).toBe(false);
      await PdfVectorStore.maybeRebuild(store);
      expect(events.length).toBe(seen);
      store.close();

      const next = await reopen();
      expect(next.events).toEqual([]);
      expect(await hnswSize(next.store)).toBe(15);
      next.store.close();
    });

    it('le corpus s’est vidé entre-temps : un index vide est complet, le PDF suivant s’écrit', async () => {
      seedChunks(3);
      const { store, events } = await failBeforeFilling();
      store.deleteDocument('doc1');
      await PdfVectorStore.maybeRebuild(store);
      expect(events.at(-1)?.status).toBe('No chunks to index');
      const seen = events.length;

      await indexDocument(store, 'doc2', 3);

      expect(store.needsRebuild()).toBe(false);
      await PdfVectorStore.maybeRebuild(store);
      expect(events.length).toBe(seen);
      expect(fs.existsSync(cliodeck('hnsw.index'))).toBe(true);
      store.close();
    });
  });

  it('échec à l’écriture : l’index en mémoire est complet, un PDF indexé ne relance rien et tout s’écrit', async () => {
    seedChunks(12);
    blockIndexWrite();
    const { store, events } = openStore();
    await store.initialize();
    expect(await hnswSize(store)).toBe(12);
    fs.rmdirSync(cliodeck('hnsw.index.meta.json.tmp'));
    const seen = events.length;

    await indexDocument(store, 'doc2', 3);

    expect(store.needsRebuild()).toBe(false);
    await PdfVectorStore.maybeRebuild(store);
    expect(events.length).toBe(seen);
    store.close();

    const next = openStore();
    await next.store.initialize();
    expect(next.events).toEqual([]);
    expect(await hnswSize(next.store)).toBe(15);
    next.store.close();
  });

  it('le scénario à la main : index et métadonnées supprimés, écriture bloquée, la recherche répond', async () => {
    seedChunks(12);
    const written = openStore();
    await written.store.rebuildIndexes();
    written.store.close();

    fs.rmSync(cliodeck('hnsw.index'));
    fs.rmSync(cliodeck('hnsw.index.meta.json'));
    blockIndexWrite();

    const { store, events } = openStore();
    await store.initialize();
    await PdfVectorStore.maybeRebuild(store);

    expect(failures(events)).toHaveLength(1);
    const query = new Float32Array(768).map((_, j) => Math.sin(j));
    expect((await store.search('archives', query, 3)).length).toBeGreaterThan(0);
    store.close();
  });

  describe('un store fermé ne publie plus rien', () => {
    it('maybeRebuild : ni levée synchrone dans le minuteur, ni rejet', async () => {
      seedChunks(3);
      const { store, events } = openStore();
      store.close();

      let pending: Promise<void> | undefined;
      expect(() => {
        pending = PdfVectorStore.maybeRebuild(store);
      }).not.toThrow();
      await expect(pending).resolves.toBeUndefined();
      expect(events).toEqual([]);
    });

    it('périmé et fermé : aucun événement, et l’index du projet quitté reste sur le disque', async () => {
      seedChunks(3, 'doc1');
      seedChunks(3, 'doc2');
      const { store, events } = openStore();
      await store.rebuildIndexes();
      const index = fs.readFileSync(cliodeck('hnsw.index'));
      const metadata = fs.readFileSync(cliodeck('hnsw.index.meta.json'));
      events.length = 0;

      // Marqué périmé pendant le préchauffage, puis l'auteur change de projet : sur le
      // projet B, sain, s'affichait « The database connection is not open ».
      store.deleteDocument('doc2');
      store.close();

      expect(store.needsRebuild()).toBe(false);
      await PdfVectorStore.maybeRebuild(store);
      await store.rebuildIndexes();

      expect(events).toEqual([]);
      expect(fs.readFileSync(cliodeck('hnsw.index')).equals(index)).toBe(true);
      expect(fs.readFileSync(cliodeck('hnsw.index.meta.json')).equals(metadata)).toBe(true);
    });

    it('fermé après un échec : le chemin du préchauffage reste muet', async () => {
      seedChunks(3);
      blockIndexWrite();
      const { store, events } = openStore();
      await store.initialize();
      const seen = events.length;
      store.close();

      await PdfVectorStore.maybeRebuild(store);

      expect(events.length).toBe(seen);
    });
  });

  it('maybeRebuild : needsRebuild lève sur une base illisible, le minuteur n’en meurt pas', async () => {
    seedChunks(3);
    const { store, events } = openStore();
    // Levé en synchrone, c'était une exception non rattrapée dans le setTimeout
    // de scheduleIndexRebuild : d'où un appel direct, sans `await` autour.
    vi.spyOn(store, 'needsRebuild').mockImplementation(() => {
      throw new Error('database disk image is malformed');
    });

    let pending: Promise<void> | undefined;
    expect(() => {
      pending = PdfVectorStore.maybeRebuild(store);
    }).not.toThrow();
    await expect(pending).resolves.toBeUndefined();
    expect(events).toEqual([]);
    store.close();
  });
});
