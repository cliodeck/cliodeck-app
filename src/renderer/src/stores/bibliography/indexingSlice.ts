import type { BatchIndexingState, IndexingSliceState, BibliographySliceCreator } from './types';
import { isPdfPath } from '../../../../../backend/core/bibliography/pdf-attachment';
import { useProjectStore } from '../projectStore';
import { refusedAsProjectChanged, stillIn, stillShown } from '../../services/still-in-project';
import i18n from '../../i18n';

/** Aucun lot en cours : ni barre de progression dans le panneau, ni indicateur dans la barre d'état. */
export function idleBatchIndexing(): BatchIndexingState {
  return { isIndexing: false, current: 0, total: 0, skipped: 0, indexed: 0, errors: [] };
}

/** Ce que rend un `pdf:index` en échec : un texte, et pour certains refus un code. */
interface PdfIndexRefusal {
  error?: string;
  code?: string;
  expected?: number;
  actual?: number;
}

/**
 * Le message d'un `pdf:index` en échec. Un PDF embarqué dans une autre dimension que le corpus (le
 * modèle d'embeddings a changé depuis la première indexation) est refusé avec un code et les deux
 * dimensions (L04-7) : l'historien lit leur traduction et le geste qui règle l'écart, jamais le
 * texte anglais du main.
 */
export function pdfIndexFailure(result: PdfIndexRefusal, fallback: string): string {
  if (result.code === 'embedding_dimension_mismatch') {
    return i18n.t('bibliography.embeddingDimensionMismatch', { corpus: result.expected, model: result.actual });
  }
  return result.error || fallback;
}

/**
 * Le projet où l'on a cliqué : le main refuse d'indexer ailleurs, et ce qu'il répond après la
 * bascule ne s'inscrit pas dans le store du suivant (S18-2-0). Sans projet, rien n'est gardé :
 * le main refuse de toute façon d'indexer. `leftNow` n'attend pas l'issue d'une ouverture
 * (`stillShown`).
 */
function leavingCheck(): {
  projectPath: string | undefined;
  left: () => Promise<boolean>;
  leftNow: () => boolean;
} {
  const projectPath = useProjectStore.getState().currentProject?.path;
  return {
    projectPath,
    left: async () => !!projectPath && !(await stillIn(projectPath)),
    leftNow: () => !!projectPath && !stillShown(projectPath),
  };
}

/** Ce que `refreshIndexedPDFs` lit d'un document de `pdf:get-all` (`VectorStore.getAllDocuments`). */
interface IndexedDocumentSummary {
  fileURL?: string;
  bibtexKey?: string;
  chunkCount?: number;
  metadata?: { textDensity?: { lowText?: boolean }; noChunks?: boolean };
}

/**
 * Indexé jusqu'au bout : des extraits, un PDF sans couche de texte qui n'en aura jamais (#132), ou
 * une indexation complète dont le filtre de qualité a tout écarté (`noChunks`, marqué par
 * l'indexeur). Les réindexer ne donnerait rien de plus. Seul le document vide hérité d'une passe
 * interrompue, sans marque, ne compte pas.
 */
function isFullyIndexed(doc: IndexedDocumentSummary): boolean {
  return (
    (doc.chunkCount ?? 0) > 0 ||
    doc.metadata?.textDensity?.lowText === true ||
    doc.metadata?.noChunks === true
  );
}

export const createIndexingSlice: BibliographySliceCreator<IndexingSliceState> = (set, get) => ({
  indexedFilePaths: new Set<string>(),
  indexedBibtexKeys: new Set<string>(),
  batchIndexing: idleBatchIndexing(),

  indexPDFFromCitation: async (citationId: string) => {
    try {
      const { citations, indexedFilePaths } = get();
      const citation = citations.find((c) => c.id === citationId);

      if (!citation || !isPdfPath(citation.file)) {
        throw new Error('No PDF file associated with this citation');
      }

      // Check if already indexed
      if (indexedFilePaths.has(citation.file)) {
        console.log(`⏭️ PDF already indexed: ${citation.title}`);
        return { alreadyIndexed: true };
      }

      console.log(`🔍 Indexing PDF for citation: ${citation.title}`);
      console.log(`📁 PDF file path: ${citation.file}`);
      const { projectPath, left } = leavingCheck();

      // Emit event to show progress in PDF panel
      window.dispatchEvent(new CustomEvent('bibliography:indexing-start', {
        detail: { citationId, title: citation.title, filePath: citation.file }
      }));

      // Pass bibliography metadata to use instead of PDF metadata extraction
      const bibliographyMetadata = {
        title: citation.title,
        author: citation.author,
        year: citation.year,
      };

      const result = await window.electron.pdf.index(citation.file, citationId, bibliographyMetadata, projectPath);

      if (refusedAsProjectChanged(result) || (await left())) {
        window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
          detail: { citationId, success: false }
        }));
        return { alreadyIndexed: false, interrupted: true };
      }

      if (!result.success) {
        const message = pdfIndexFailure(result, 'Failed to index PDF');
        window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
          detail: { citationId, success: false, error: message }
        }));
        throw new Error(message);
      }

      // Add to indexed set
      set((state) => ({
        indexedFilePaths: new Set([...state.indexedFilePaths, citation.file!])
      }));

      window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
        detail: { citationId, success: true }
      }));

      console.log(`✅ PDF indexed from citation: ${citation.title}`);
      return { alreadyIndexed: false };
    } catch (error) {
      console.error('❌ Failed to index PDF from citation:', error);
      throw error;
    }
  },

  reindexPDFFromCitation: async (citationId: string) => {
    try {
      const { citations } = get();
      const citation = citations.find((c) => c.id === citationId);

      if (!citation) {
        throw new Error('Citation not found');
      }

      // Après chaque attente : un autre projet ouvert entre-temps recevrait le PDF de celui-ci
      // dans son corpus.
      const { projectPath, left } = leavingCheck();

      // Resolution order for the PDF path on disk:
      //   1. `citation.file`, when it is a PDF — what BibTeX or the in-memory
      //      Zotero download flow gave us. Cheapest and most accurate. A
      //      legacy HTML snapshot (`PDFs/1706.html`) is not: indexing it fails
      //      on « Invalid PDF structure », and the known PDF below is skipped.
      //   2. Existing indexed document's `fileURL` — the previous index
      //      knows exactly which file it ran on. Restoring this covers the
      //      Zotero-only flow whose BibTeX has no `file =` and whose
      //      metadata.json got saved with an empty attachments array
      //      (separate bug — a whole-file metadata write could overwrite
      //      populated state).
      //   3. First downloaded Zotero attachment's `localPath`.
      // If none of the three resolves, indexing is genuinely impossible.
      let filePath: string | undefined = isPdfPath(citation.file) ? citation.file : undefined;
      if (!filePath) {
        try {
          const allDocs = await window.electron.pdf.getAll();
          if (await left()) return { interrupted: true };
          if (allDocs.success && Array.isArray(allDocs.documents)) {
            const existing = allDocs.documents.find(
              (d: { bibtexKey?: string; fileURL?: string }) =>
                d.bibtexKey === citationId,
            );
            if (existing?.fileURL) filePath = existing.fileURL;
          }
        } catch (e) {
          console.warn('reindex: failed to look up existing document path:', e);
        }
      }
      if (!filePath) {
        const downloadedAttachment = citation.zoteroAttachments?.find(
          (a) => a.downloaded && a.localPath,
        );
        if (downloadedAttachment?.localPath) filePath = downloadedAttachment.localPath;
      }
      if (!filePath) {
        throw new Error(
          'No PDF file associated with this citation (BibTeX has no `file` field, no previously indexed copy found, no downloaded Zotero attachment).',
        );
      }

      // Rien n'est supprimé d'avance (S03-1-3) : `pdf:index` remplace le document de ce fichier une
      // fois les nouveaux extraits écrits, et lui rattache les citations entrantes et les
      // collections (`mergeDocumentsInto`). Un échec (Ollama arrêté, PDF illisible, délai du worker)
      // laisse l'ancien document dans le corpus, cherchable par le chat.
      console.log(`🔄 Re-indexing PDF for citation: ${citation.title}`);

      window.dispatchEvent(new CustomEvent('bibliography:indexing-start', {
        detail: { citationId, title: citation.title, filePath }
      }));

      const bibliographyMetadata = {
        title: citation.title,
        author: citation.author,
        year: citation.year,
      };

      const result = await window.electron.pdf.index(filePath, citationId, bibliographyMetadata, projectPath);

      if (refusedAsProjectChanged(result) || (await left())) {
        window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
          detail: { citationId, success: false }
        }));
        return { interrupted: true };
      }

      if (!result.success) {
        const message = pdfIndexFailure(result, 'Failed to re-index PDF');
        window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
          detail: { citationId, success: false, error: message }
        }));
        throw new Error(message);
      }

      // Add to indexed set
      set((state) => ({
        indexedFilePaths: new Set([...state.indexedFilePaths, filePath!])
      }));

      window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
        detail: { citationId, success: true }
      }));

      console.log(`✅ PDF re-indexed from citation: ${citation.title}`);
      return {};
    } catch (error) {
      console.error('❌ Failed to re-index PDF from citation:', error);
      throw error;
    }
  },

  indexAllPDFs: async (projectPath: string) => {
    const { citations } = get();
    const itemsWithFile = citations.filter((c) => isPdfPath(c.file)).length;

    // Refresh indexed PDFs list first
    await get().refreshIndexedPDFs();
    // Un autre projet ouvert pendant la relecture : le lot ne démarre pas.
    if (!(await stillIn(projectPath))) {
      return { indexed: 0, skipped: 0, errors: [], interrupted: true, remaining: itemsWithFile };
    }

    // Get citations with PDFs that are not yet indexed, deduplicated by
    // filePath. A Zotero library can have many bibliography items pointing
    // to the same PDF (e.g. per-day diary entries in one monthly scan);
    // indexing each item separately re-extracts, re-embeds and re-stores
    // the same PDF — O(items) instead of O(PDFs). Dedup at batch-entry
    // because `indexedFilePaths` only updates after each IPC returns, so
    // the pre-existing `.has()` check alone does not deduplicate within
    // a single batch.
    const alreadyIndexed = get().indexedFilePaths;
    const seenInBatch = new Set<string>();
    const citationsWithPDFs = citations.filter((c) => {
      // Un fichier rattaché qui n'est pas un PDF (instantané HTML) n'est pas
      // à indexer : ce n'est pas une erreur, c'est hors lot.
      if (!isPdfPath(c.file)) return false;
      if (alreadyIndexed.has(c.file)) return false;
      if (seenInBatch.has(c.file)) return false;
      seenInBatch.add(c.file);
      return true;
    });

    if (citationsWithPDFs.length === 0) {
      return { indexed: 0, skipped: 0, errors: [] };
    }

    if (itemsWithFile > citationsWithPDFs.length) {
      const duplicates = itemsWithFile - citationsWithPDFs.length;
      console.log(
        `[indexing] Deduped batch: ${duplicates} of ${itemsWithFile} items skipped — ` +
          `their filePath is already queued by another item. ` +
          `This usually means bibtexKey collision in the bibtex export or multiple Zotero items sharing a single attachment.`
      );
    }

    const errors: string[] = [];
    let indexed = 0;
    let skipped = 0;
    /**
     * Le projet du lot n'est plus l'ouvert (S18-2-0) : ses PDF suivants iraient dans le corpus de
     * l'autre. Le lot s'arrête, la progression disparaît, et ce qui reste se dit.
     */
    const interrupt = () => {
      set({ batchIndexing: idleBatchIndexing() });
      const remaining = citationsWithPDFs.length - indexed - skipped - errors.length;
      return { indexed, skipped, errors, interrupted: true as const, remaining };
    };

    set({
      batchIndexing: {
        isIndexing: true,
        current: 0,
        total: citationsWithPDFs.length,
        skipped: 0,
        indexed: 0,
        errors: [],
      }
    });

    for (let i = 0; i < citationsWithPDFs.length; i++) {
      const citation = citationsWithPDFs[i];
      if (!(await stillIn(projectPath))) return interrupt();

      set((state) => ({
        batchIndexing: {
          ...state.batchIndexing,
          current: i + 1,
          currentCitation: {
            citationId: citation.id,
            title: citation.title,
            progress: 0,
            stage: 'Initialisation...',
          }
        }
      }));

      try {
        // Check again in case it was indexed during batch
        if (get().indexedFilePaths.has(citation.file!)) {
          skipped++;
          set((state) => ({
            batchIndexing: { ...state.batchIndexing, skipped }
          }));
          continue;
        }

        window.dispatchEvent(new CustomEvent('bibliography:indexing-start', {
          detail: { citationId: citation.id, title: citation.title, filePath: citation.file }
        }));

        // Pass bibliography metadata to use instead of PDF metadata extraction
        const bibliographyMetadata = {
          title: citation.title,
          author: citation.author,
          year: citation.year,
        };

        const result = await window.electron.pdf.index(citation.file!, citation.id, bibliographyMetadata, projectPath);

        // Le PDF en vol a été indexé dans le projet du lot : il compte, mais l'ouvert n'en sait rien.
        if (refusedAsProjectChanged(result) || !(await stillIn(projectPath))) {
          if (result.success) indexed++;
          window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
            detail: { citationId: citation.id, success: result.success }
          }));
          return interrupt();
        }

        const failure = result.success ? undefined : pdfIndexFailure(result, 'Failed to index PDF');
        if (result.success) {
          indexed++;
          set((state) => ({
            indexedFilePaths: new Set([...state.indexedFilePaths, citation.file!]),
            batchIndexing: { ...state.batchIndexing, indexed }
          }));
        } else {
          console.error('❌ [indexing] Échec:', citation.title, result.error);
          errors.push(`${citation.title}: ${failure}`);
        }

        window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
          detail: { citationId: citation.id, success: result.success, error: failure }
        }));
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ [indexing] Échec:', citation.title, errorMsg);
        errors.push(`${citation.title}: ${errorMsg}`);
        window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
          detail: { citationId: citation.id, success: false, error: errorMsg }
        }));
      }
    }

    set({
      batchIndexing: {
        isIndexing: false,
        current: citationsWithPDFs.length,
        total: citationsWithPDFs.length,
        skipped,
        indexed,
        errors,
      }
    });

    return { indexed, skipped, errors };
  },

  refreshIndexedPDFs: async () => {
    console.log('🔄 refreshIndexedPDFs called...');
    try {
      const result = await window.electron.pdf.getAll();
      console.log('📄 pdf.getAll result:', { success: result.success, documentCount: result.documents?.length });
      if (result.success && Array.isArray(result.documents)) {
        // Extract file paths from indexed documents
        // Documents store the original file path or we can match by bibtexKey
        const indexedPaths = new Set<string>();

        // Also get bibtex keys to match with citations
        const indexedBibtexKeys = new Set<string>();

        // Debug: log first few documents to see structure
        if (result.documents.length > 0) {
          console.log('📄 Sample document structure:', JSON.stringify(result.documents[0], null, 2));
        }

        result.documents.forEach((doc: IndexedDocumentSummary) => {
          // Un document sans extrait ni marque est le reste d'une indexation interrompue d'avant
          // l'écriture tout ou rien. Compté indexé, il n'était plus jamais reproposé, ni par son
          // chemin ni par sa clé (S03-1-0). Un PDF sans texte (`lowText`, #132) ou marqué
          // `noChunks` n'a pas d'extrait non plus, mais le réindexer ne donnerait rien de plus.
          if (!isFullyIndexed(doc)) return;
          // Document stores file path as fileURL (from backend)
          if (doc.fileURL) {
            indexedPaths.add(doc.fileURL);
          }
          if (doc.bibtexKey) {
            indexedBibtexKeys.add(doc.bibtexKey);
          }
        });

        // Debug: log sample bibtexKeys
        const sampleKeys = Array.from(indexedBibtexKeys).slice(0, 5);
        console.log('📎 Sample indexed bibtexKeys:', sampleKeys);

        // Match citations by bibtexKey and add their file paths
        const { citations } = get();
        console.log(`📋 Matching ${indexedBibtexKeys.size} bibtexKeys against ${citations.length} citations`);

        // Debug: log sample citation IDs
        const sampleCitationIds = citations.slice(0, 5).map(c => c.id);
        console.log('📚 Sample citation IDs:', sampleCitationIds);

        citations.forEach((citation) => {
          if (citation.file && indexedBibtexKeys.has(citation.id)) {
            indexedPaths.add(citation.file);
          }
        });

        set({ indexedFilePaths: indexedPaths, indexedBibtexKeys });
        console.log(`📚 Refreshed indexed PDFs: ${indexedPaths.size} files, ${indexedBibtexKeys.size} bibtexKeys`);
      } else {
        console.warn('⚠️ refreshIndexedPDFs: pdf.getAll returned no documents or failed', result);
      }
    } catch (error) {
      console.error('❌ Failed to refresh indexed PDFs:', error);
    }
  },

  isFileIndexed: (filePath: string) => {
    return get().indexedFilePaths.has(filePath);
  },

  isBibtexKeyIndexed: (bibtexKey: string) => {
    return get().indexedBibtexKeys.has(bibtexKey);
  },
});
