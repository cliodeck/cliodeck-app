/**
 * Un fichier, un document.
 *
 * Mesuré sur un projet réel : 221 documents pour 55 PDF, 5 920 extraits dont
 * 1 264 distincts. Chaque clic sur « Indexer tous les PDFs » ou
 * « Télécharger depuis Zotero » ajoutait une copie complète, car
 * l'indexeur ne regardait jamais si le fichier était déjà là.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sqliteAvailable } from '@backend/__tests__/helpers/native-guards';
import Database from 'better-sqlite3';
import { VectorStore } from '../core/vector-store/VectorStore';
import { EnhancedVectorStore } from '../core/vector-store/EnhancedVectorStore';
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

  /*
   * Revue de L05-6. Le document de la tentative est enregistré avant les embeddings. Il restait
   * après l'échec, vide, à côté de l'ancien que « Ré-indexer » ne supprime plus : le panneau
   * listait la référence deux fois, et l'ouverture suivante copiait tout `brain.db` avant de
   * fondre ce doublon.
   */
  it('une réindexation qui échoue ne laisse aucun document de la tentative à côté de l’ancien', async () => {
    const first = await indexer(store).indexPDF(FILE, 'Kansteiner_2022', undefined, META);
    const chunks = store.getChunksForDocument(first.id).length;
    const broken = async (): Promise<Float32Array> => {
      throw new Error('Ollama éteint');
    };

    await expect(indexer(store, TEXT, broken).indexPDF(FILE, 'Kansteiner_2022', undefined, META)).rejects.toThrow();

    expect(store.getDocumentIdsByFilePath(FILE)).toEqual([first.id]);
    expect(store.getChunksForDocument(first.id)).toHaveLength(chunks);
    expect(store.countDuplicateDocuments()).toBe(0);
  });

  it('un échec au milieu des extraits ne laisse pas une copie partielle, que le nettoyage préférerait', async () => {
    // Filtres coupés : le texte répété des tests donne alors plusieurs extraits, écrits un à un.
    const raw = (embedding: typeof embed) =>
      new PDFIndexer(
        store,
        embedding,
        'cpuOptimized',
        undefined,
        false,
        { enablePreprocessing: false, enableQualityFiltering: false, enableDeduplication: false },
        extract(TEXT)
      );
    const first = await raw(embed).indexPDF(FILE, 'Kansteiner_2022', undefined, META);
    const chunks = store.getChunksForDocument(first.id).length;
    expect(chunks).toBeGreaterThan(1);
    let calls = 0;
    const flaky = async (content: string): Promise<Float32Array> => {
      calls += 1;
      if (calls > 1) throw new Error('Ollama éteint');
      return embed(content);
    };

    await expect(raw(flaky).indexPDF(FILE, 'Kansteiner_2022', undefined, META)).rejects.toThrow();
    // Le nettoyage du démarrage garde la copie la plus récente qui a des extraits : une copie
    // partielle de la tentative y aurait remplacé la complète.
    store.removeDuplicateDocuments();

    expect(store.getDocumentIdsByFilePath(FILE)).toEqual([first.id]);
    expect(store.getChunksForDocument(first.id)).toHaveLength(chunks);
  });

  it('un échec après le remplacement garde le nouveau document, seul à porter les extraits', async () => {
    const first = await indexer(store).indexPDF(FILE, 'Kansteiner_2022', undefined, META);
    // Les similarités se calculent après le remplacement des copies précédentes.
    vi.spyOn(store, 'computeAndSaveSimilarities').mockImplementation(() => {
      throw new Error('disque plein');
    });

    await expect(indexer(store).indexPDF(FILE, 'Kansteiner_2022', undefined, META)).rejects.toThrow('disque plein');

    const ids = store.getDocumentIdsByFilePath(FILE);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(first.id);
    expect(store.getChunksForDocument(ids[0]).length).toBeGreaterThan(0);
  });

  it('une première indexation qui échoue ne laisse aucun document', async () => {
    const broken = async (): Promise<Float32Array> => {
      throw new Error('Ollama éteint');
    };

    await expect(indexer(store, TEXT, broken).indexPDF(FILE, 'Kansteiner_2022', undefined, META)).rejects.toThrow();

    expect(store.getStatistics()).toMatchObject({ documentCount: 0, chunkCount: 0 });
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

    /*
     * « Réindexer » depuis la fiche supprimait le document de la clé avant d'indexer (S03-1-3) :
     * c'est ce qui retirait aussi la copie d'un PDF déplacé. Sans la suppression, l'indexeur
     * reconnaît lui-même un PDF déplacé : même clé, ancien fichier disparu, même nom.
     */
    it('un PDF déplacé est fondu dans sa réindexation, et la citation entrante le suit', async () => {
      const before = realPdf('Kansteiner_2022.pdf');
      const first = await indexer(store).indexPDF(before, 'Kansteiner_2022', undefined, META);
      store.saveDocument(doc('citant', realPdf('Citant.pdf'), '2026-09-11T10:00:00Z'));
      store.saveCitation({ id: 'cit', sourceDocId: 'citant', targetCitation: 'Kansteiner 2022', targetDocId: first.id });
      const after = path.join(dir, 'Rangés', 'Kansteiner_2022.pdf');
      fs.mkdirSync(path.dirname(after), { recursive: true });
      fs.renameSync(before, after);

      const second = await indexer(store).indexPDF(after, 'Kansteiner_2022', undefined, META);

      expect(store.getDocument(first.id)).toBeNull();
      expect(store.getStatistics().documentCount).toBe(2);
      expect(store.getCitationsForDocument('citant')[0]).toMatchObject({ targetDocId: second.id });
      expect(store.getAllChunksWithEmbeddings().every((c) => c.chunk.documentId !== first.id)).toBe(true);
    });

    it('une notice à deux PDF présents garde les deux, même de même nom', async () => {
      const original = realPdf('Kansteiner_2022.pdf');
      const annotated = path.join(dir, 'Annotés', 'Kansteiner_2022.pdf');
      fs.mkdirSync(path.dirname(annotated), { recursive: true });
      fs.writeFileSync(annotated, '%PDF-1.4');

      const first = await indexer(store).indexPDF(original, 'Kansteiner_2022', undefined, META);
      const second = await indexer(store).indexPDF(annotated, 'Kansteiner_2022', undefined, META);

      expect(store.getStatistics().documentCount).toBe(2);
      expect(store.getDocument(first.id)).not.toBeNull();
      expect(store.getDocument(second.id)).not.toBeNull();
    });

    it('un PDF disparu d’un autre nom, sous la même clé, n’est pas fondu', async () => {
      const gone = realPdf('Kansteiner_2022_original.pdf');
      const first = await indexer(store).indexPDF(gone, 'Kansteiner_2022', undefined, META);
      fs.rmSync(gone);

      await indexer(store).indexPDF(realPdf('Kansteiner_2022_annote.pdf'), 'Kansteiner_2022', undefined, META);

      expect(store.getDocument(first.id)).not.toBeNull();
      expect(store.getStatistics().documentCount).toBe(2);
    });

    it('jumeaux Better BibTeX : le document d’une jumelle dont le fichier est présent n’est jamais fondu', async () => {
      // Deux entrées du journal de Lester exportées sous la même clé, chacune son PDF, de même nom.
      const twinA = path.join(dir, 'ZKA', 'Lester_1935.pdf');
      const twinB = path.join(dir, 'ZKB', 'Lester_1935.pdf');
      for (const p of [twinA, twinB]) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '%PDF-1.4');
      }
      const a = await indexer(store).indexPDF(twinA, 'Lester_1935', undefined, META);
      const b = await indexer(store).indexPDF(twinB, 'Lester_1935', undefined, META);

      // Réindexer la seconde ne touche pas à la première.
      const b2 = await indexer(store).indexPDF(twinB, 'Lester_1935', undefined, META);

      expect(store.getDocument(a.id)).not.toBeNull();
      expect(store.getChunksForDocument(a.id).length).toBeGreaterThan(0);
      expect(store.getDocument(b.id)).toBeNull();
      expect(store.getDocumentIdsByFilePath(twinB)).toEqual([b2.id]);
      expect(store.getStatistics().documentCount).toBe(2);
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

/*
 * Le store de l'app : SQLite, plus HNSW et BM25, qui ne savent pas retirer un vecteur. Tout
 * retrait de document les marque périmés, d'où une reconstruction complète. Celui d'une passe
 * échouée avant ses extraits n'a rien à y retirer.
 */
describe.skipIf(!sqliteAvailable)('PDF : échec d’indexation sur le store de l’app', () => {
  let dir: string;
  let store: EnhancedVectorStore;

  async function embed768(content: string): Promise<Float32Array> {
    const v = new Float32Array(768);
    for (let i = 0; i < content.length; i++) v[i % 768] += content.charCodeAt(i) / 1000;
    return v;
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-echec-enhanced-'));
    store = new EnhancedVectorStore(dir);
    await store.initialize();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('une indexation qui échoue avant ses extraits ne laisse rien et ne demande aucune reconstruction', async () => {
    const enhancedIndexer = (embedding: typeof embed768) =>
      new PDFIndexer(store, embedding, 'cpuOptimized', undefined, false, {}, extract(TEXT));
    await enhancedIndexer(embed768).indexPDF('/projet/PDFs/Autre.pdf', 'Autre_2020', undefined, META);
    expect(store.needsRebuild()).toBe(false);
    const broken = async (): Promise<Float32Array> => {
      throw new Error('Ollama éteint');
    };

    await expect(enhancedIndexer(broken).indexPDF(FILE, 'Kansteiner_2022', undefined, META)).rejects.toThrow();

    expect(store.getDocumentIdsByFilePath(FILE)).toEqual([]);
    expect(store.getAllDocuments()).toHaveLength(1);
    expect(store.needsRebuild()).toBe(false);
  });
});
