/**
 * Un fichier, un document.
 *
 * Mesuré sur un projet réel : 221 documents pour 55 PDF, 5 920 extraits dont
 * 1 264 distincts. Chaque clic sur « Indexer tous les PDFs » ou
 * « Télécharger depuis Zotero » ajoutait une copie complète, car
 * l'indexeur ne regardait jamais si le fichier était déjà là.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteAvailable } from '@backend/__tests__/helpers/native-guards';
import Database from 'better-sqlite3';
import { VectorStore } from '../core/vector-store/VectorStore';
import { PDFIndexer } from '../core/pdf/PDFIndexer';
import type { PDFDocument } from '../types/pdf-document';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const FILE = '/projet/PDFs/Kansteiner_2022.pdf';

const TEXT =
  'Digital history requires historians to reflect on the transformations their tools impose on sources. ' +
  'Each software layer rewrites the source like a palimpsest, and the historian must document every layer carefully. ' +
  'Machine learning models trained on archives reproduce the silences of those archives unless corrected. ';

function extract(text: string) {
  return async () => ({
    pages: [
      { pageNumber: 1, text: text.repeat(6) },
      { pageNumber: 2, text: text.repeat(6) },
    ],
    metadata: {},
    title: 'Digital Doping for Historians',
  });
}

async function embed(content: string): Promise<Float32Array> {
  const v = new Float32Array(8);
  for (let i = 0; i < content.length; i++) v[i % 8] += content.charCodeAt(i) / 1000;
  return v;
}

function indexer(store: VectorStore, text = TEXT, embedding = embed): PDFIndexer {
  return new PDFIndexer(store, embedding, 'cpuOptimized', undefined, false, {}, extract(text));
}

const META = { title: 'Digital Doping for Historians', author: 'Kansteiner, Wulf', year: '2022' };

function doc(id: string, filePath: string, indexedAt: string): PDFDocument {
  const date = new Date(indexedAt);
  return {
    id,
    fileURL: filePath,
    title: id,
    pageCount: 1,
    metadata: {},
    createdAt: date,
    indexedAt: date,
    lastAccessedAt: date,
    get displayString() {
      return this.title;
    },
  };
}

describe.skipIf(!sqliteAvailable)('PDF : un fichier, un document', () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-doublons-'));
    store = new VectorStore(dir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('réindexer un PDF déjà présent le remplace au lieu de l’ajouter', async () => {
    await indexer(store).indexPDF(FILE, 'Kansteiner_2022', undefined, META);
    const second = await indexer(store).indexPDF(FILE, 'Kansteiner_2022', undefined, META);

    expect(store.getStatistics().documentCount).toBe(1);
    expect(store.getDocumentIdsByFilePath(FILE)).toEqual([second.id]);
    // Plus aucun extrait orphelin de la première copie.
    const chunks = store.getAllChunksWithEmbeddings();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.chunk.documentId === second.id)).toBe(true);
  });

  it('une réindexation qui échoue laisse l’ancienne copie intacte', async () => {
    const first = await indexer(store).indexPDF(FILE, 'Kansteiner_2022', undefined, META);
    const broken = async (): Promise<Float32Array> => {
      throw new Error('Ollama éteint');
    };

    await expect(indexer(store, TEXT, broken).indexPDF(FILE, 'Kansteiner_2022', undefined, META)).rejects.toThrow();

    expect(store.getDocumentIdsByFilePath(FILE)).toContain(first.id);
    expect(store.getChunksForDocument(first.id).length).toBeGreaterThan(0);
  });

  it('deux fichiers différents restent deux documents', async () => {
    await indexer(store).indexPDF(FILE, 'Kansteiner_2022', undefined, META);
    await indexer(store).indexPDF('/projet/PDFs/Autre.pdf', 'Autre_2020', undefined, META);
    expect(store.getStatistics().documentCount).toBe(2);
  });

  it('fondre des copies rattache au document gardé les citations et les collections', () => {
    store.saveDocument(doc('garde', FILE, '2026-09-13T10:00:00Z'));
    store.saveDocument(doc('copie', FILE, '2026-09-11T10:00:00Z'));
    store.saveDocument(doc('citant', '/projet/PDFs/Citant.pdf', '2026-09-11T10:00:00Z'));
    store.saveCollections([{ key: 'COLL1', name: 'Forge' }]);
    store.setDocumentCollections('copie', ['COLL1']);
    store.saveCitation({ id: 'cit', sourceDocId: 'citant', targetCitation: 'Kansteiner 2022', targetDocId: 'copie' });

    store.mergeDocumentsInto('garde', ['copie']);

    expect(store.getDocument('copie')).toBeNull();
    expect(store.getDocumentCollections('garde')).toEqual(['COLL1']);
    expect(store.getCitationsForDocument('citant')[0]).toMatchObject({ targetDocId: 'garde' });
  });

  it('nettoie une base héritée : garde la copie la plus récente qui a des extraits', async () => {
    const vec = new Float32Array(8).fill(1);
    store.saveDocument(doc('ancienne', FILE, '2026-07-22T08:00:00Z'));
    store.saveDocument(doc('recente', FILE, '2026-09-11T09:00:00Z'));
    store.saveDocument(doc('interrompue', FILE, '2026-09-13T15:00:00Z'));
    store.saveDocument(doc('seule', '/projet/PDFs/Seule.pdf', '2026-09-13T15:00:00Z'));
    for (const id of ['ancienne', 'recente', 'seule']) {
      store.saveChunk(
        { id: `${id}-0`, documentId: id, content: 'texte', pageNumber: 1, chunkIndex: 0, startPosition: 0, endPosition: 5 },
        vec
      );
    }

    expect(store.countDuplicateDocuments()).toBe(2);
    expect(store.removeDuplicateDocuments()).toEqual({ files: 1, removed: 2 });

    expect(store.getDocumentIdsByFilePath(FILE)).toEqual(['recente']);
    expect(store.countDuplicateDocuments()).toBe(0);
    expect(store.getStatistics()).toMatchObject({ documentCount: 2, chunkCount: 2 });
  });

  it('sauvegarde la base avant nettoyage', async () => {
    store.saveDocument(doc('a', FILE, '2026-09-11T09:00:00Z'));
    const backup = path.join(dir, 'brain.db.avant-dedoublonnage');
    await store.backupTo(backup);
    const copy = new Database(backup, { readonly: true });
    try {
      expect(copy.prepare('SELECT id FROM pdf_documents').all()).toEqual([{ id: 'a' }]);
    } finally {
      copy.close();
    }
  });

  describe('un même fichier sous deux chemins (#123)', () => {
    /** Le disque des tests ignore-t-il la casse (APFS par défaut) ? */
    function caseInsensitiveDisk(): boolean {
      const probe = path.join(dir, 'Sonde-Casse');
      fs.writeFileSync(probe, 'x');
      try {
        return fs.existsSync(path.join(dir, 'sonde-casse'));
      } finally {
        fs.rmSync(probe, { force: true });
      }
    }

    function realPdf(name: string): string {
      const p = path.join(dir, 'PDFs', name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '%PDF-1.4');
      return p;
    }

    it('réindexer un fichier renommé en ne changeant que la casse le remplace', async (ctx) => {
      if (!caseInsensitiveDisk()) ctx.skip();
      const onDisk = realPdf('Hughes_-_2025_-_ETHICS_FOR_ARTIFICIAL_HISTORIANS.pdf');
      const renamed = onDisk.replace('ETHICS_FOR_ARTIFICIAL_HISTORIANS', 'Ethics_for_artificial_historians');

      await indexer(store).indexPDF(renamed, 'Hughes_2025', undefined, META);
      const second = await indexer(store).indexPDF(onDisk, 'Hughes_2025', undefined, META);

      expect(store.getStatistics().documentCount).toBe(1);
      expect(store.getDocumentIdsByFilePath(onDisk)).toEqual([second.id]);
      expect(store.getDocumentIdsByFilePath(renamed)).toEqual([second.id]);
    });

    it('le même PDF atteint par un dossier lié ne crée pas de second document', async () => {
      // Cas réel : un dossier OneDrive atteint par `~/OneDrive…` (lien) comme
      // par `~/Library/CloudStorage/…`.
      const real = realPdf('Kansteiner_2022.pdf');
      const linkedDir = path.join(dir, 'OneDrive');
      fs.symlinkSync(path.dirname(real), linkedDir);
      const viaLink = path.join(linkedDir, 'Kansteiner_2022.pdf');

      await indexer(store).indexPDF(real, 'Kansteiner_2022', undefined, META);
      await indexer(store).indexPDF(viaLink, 'Kansteiner_2022', undefined, META);

      expect(store.getStatistics().documentCount).toBe(1);
    });

    it('le nettoyage de démarrage fond les copies héritées sous un autre chemin du même fichier', () => {
      const real = realPdf('Kansteiner_2022.pdf');
      const link = path.join(dir, 'lien.pdf');
      fs.symlinkSync(real, link);
      store.saveDocument(doc('recente', real, '2026-09-11T09:00:00Z'));
      store.saveDocument(doc('ancienne', link, '2026-07-22T08:00:00Z'));
      store.saveDocument(doc('autre', realPdf('Autre.pdf'), '2026-07-22T08:00:00Z'));

      expect(store.countDuplicateDocuments()).toBe(1);
      expect(store.removeDuplicateDocuments()).toEqual({ files: 1, removed: 1 });
      expect(store.getDocument('ancienne')).toBeNull();
      expect(store.getStatistics().documentCount).toBe(2);
    });
  });
});
