import type { IndexingSliceState, BibliographySliceCreator } from './types';

export const createIndexingSlice: BibliographySliceCreator<IndexingSliceState> = (set, get) => ({
  indexedFilePaths: new Set<string>(),
  indexedBibtexKeys: new Set<string>(),
  batchIndexing: {
    isIndexing: false,
    current: 0,
    total: 0,
    skipped: 0,
    indexed: 0,
    errors: [],
  },

  indexPDFFromCitation: async (citationId: string) => {
    try {
      const { citations, indexedFilePaths } = get();
      const citation = citations.find((c) => c.id === citationId);

      if (!citation || !citation.file) {
        throw new Error('No PDF file associated with this citation');
      }

      // Check if already indexed
      if (indexedFilePaths.has(citation.file)) {
        console.log(`⏭️ PDF already indexed: ${citation.title}`);
        return { alreadyIndexed: true };
      }

      console.log(`🔍 Indexing PDF for citation: ${citation.title}`);
      console.log(`📁 PDF file path: ${citation.file}`);

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

      const result = await window.electron.pdf.index(citation.file, citationId, bibliographyMetadata);

      if (!result.success) {
        window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
          detail: { citationId, success: false, error: result.error }
        }));
        throw new Error(result.error || 'Failed to index PDF');
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

  getDocumentIdForCitation: async (citationId: string) => {
    try {
      const result = await window.electron.pdf.getAll();
      if (result.success && Array.isArray(result.documents)) {
        // Find document with matching bibtexKey
        const doc = result.documents.find((d: any) => d.bibtexKey === citationId);
        return doc?.id || null;
      }
      return null;
    } catch (error) {
      console.error('Failed to get document ID for citation:', error);
      return null;
    }
  },

  reindexPDFFromCitation: async (citationId: string) => {
    try {
      const { citations } = get();
      const citation = citations.find((c) => c.id === citationId);

      if (!citation || !citation.file) {
        throw new Error('No PDF file associated with this citation');
      }

      // Find and delete existing indexed document
      const documentId = await get().getDocumentIdForCitation(citationId);
      if (documentId) {
        console.log(`🗑️ Deleting existing indexed PDF for: ${citation.title}`);
        await window.electron.pdf.delete(documentId);

        // Remove from indexed set
        set((state) => {
          const newIndexedPaths = new Set(state.indexedFilePaths);
          newIndexedPaths.delete(citation.file!);
          return { indexedFilePaths: newIndexedPaths };
        });
      }

      // Now re-index
      console.log(`🔄 Re-indexing PDF for citation: ${citation.title}`);

      window.dispatchEvent(new CustomEvent('bibliography:indexing-start', {
        detail: { citationId, title: citation.title, filePath: citation.file }
      }));

      const bibliographyMetadata = {
        title: citation.title,
        author: citation.author,
        year: citation.year,
      };

      const result = await window.electron.pdf.index(citation.file, citationId, bibliographyMetadata);

      if (!result.success) {
        window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
          detail: { citationId, success: false, error: result.error }
        }));
        throw new Error(result.error || 'Failed to re-index PDF');
      }

      // Add back to indexed set
      set((state) => ({
        indexedFilePaths: new Set([...state.indexedFilePaths, citation.file!])
      }));

      window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
        detail: { citationId, success: true }
      }));

      console.log(`✅ PDF re-indexed from citation: ${citation.title}`);
    } catch (error) {
      console.error('❌ Failed to re-index PDF from citation:', error);
      throw error;
    }
  },

  indexAllPDFs: async () => {
    const { citations } = get();

    // Refresh indexed PDFs list first
    await get().refreshIndexedPDFs();

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
      if (!c.file) return false;
      if (alreadyIndexed.has(c.file)) return false;
      if (seenInBatch.has(c.file)) return false;
      seenInBatch.add(c.file);
      return true;
    });

    if (citationsWithPDFs.length === 0) {
      return { indexed: 0, skipped: 0, errors: [] };
    }

    const itemsWithFile = citations.filter((c) => c.file).length;
    if (itemsWithFile > citationsWithPDFs.length) {
      console.log(
        `📚 [indexing] ${citationsWithPDFs.length} unique PDFs to index ` +
          `(from ${itemsWithFile} bibliography items — ${itemsWithFile - citationsWithPDFs.length} share a PDF with another item)`
      );
    }

    const errors: string[] = [];
    let indexed = 0;
    let skipped = 0;

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

        const result = await window.electron.pdf.index(citation.file!, citation.id, bibliographyMetadata);

        if (result.success) {
          indexed++;
          set((state) => ({
            indexedFilePaths: new Set([...state.indexedFilePaths, citation.file!]),
            batchIndexing: { ...state.batchIndexing, indexed }
          }));
        } else {
          errors.push(`${citation.title}: ${result.error}`);
        }

        window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
          detail: { citationId: citation.id, success: result.success, error: result.error }
        }));
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
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

        result.documents.forEach((doc: any) => {
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
