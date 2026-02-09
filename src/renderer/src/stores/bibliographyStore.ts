import { create } from 'zustand';

// MARK: - Types

export interface ZoteroAttachmentInfo {
  key: string; // Zotero attachment key
  filename: string;
  contentType: string;
  downloaded: boolean;
  localPath?: string; // Path to downloaded PDF
  dateModified?: string;
  md5?: string;
}

export interface Citation {
  id: string;
  key?: string; // Alternative BibTeX key
  type: string;
  author: string;
  year: string;
  title: string;
  shortTitle?: string;
  journal?: string;
  publisher?: string;
  booktitle?: string;
  file?: string;

  // Zotero metadata
  zoteroKey?: string; // Zotero item key
  zoteroAttachments?: ZoteroAttachmentInfo[]; // PDF attachments from Zotero

  // Tags and metadata
  tags?: string[];
  keywords?: string;
  notes?: string;
  customFields?: Record<string, string>;
  dateAdded?: string;
  dateModified?: string;
}

export interface IndexingProgress {
  citationId: string;
  title: string;
  progress: number;
  stage: string;
}

export interface BatchIndexingState {
  isIndexing: boolean;
  current: number;
  total: number;
  currentCitation?: IndexingProgress;
  skipped: number;
  indexed: number;
  errors: string[];
}

interface BibliographyState {
  // Citations
  citations: Citation[];
  filteredCitations: Citation[];
  selectedCitationId: string | null;

  // Indexed PDFs tracking
  indexedFilePaths: Set<string>;
  indexedBibtexKeys: Set<string>;

  // Batch indexing state
  batchIndexing: BatchIndexingState;

  // Search & filters
  searchQuery: string;
  sortBy: 'author' | 'year' | 'title';
  sortOrder: 'asc' | 'desc';
  selectedTags: string[]; // Tags filter

  // Actions
  loadBibliography: (filePath: string) => Promise<void>;
  loadBibliographyWithMetadata: (filePath: string, projectPath: string) => Promise<void>;
  mergeBibliography: (filePath: string) => Promise<{ newCitations: number; duplicates: number; total: number }>;
  searchCitations: (query: string) => void;
  setSortBy: (field: 'author' | 'year' | 'title') => void;
  toggleSortOrder: () => void;

  selectCitation: (citationId: string) => void;
  insertCitation: (citationId: string) => void;

  // Tags & metadata
  updateCitationMetadata: (citationId: string, updates: Partial<Citation>) => void;
  getAllTags: () => string[];
  setTagsFilter: (tags: string[]) => void;
  clearTagsFilter: () => void;

  indexPDFFromCitation: (citationId: string) => Promise<{ alreadyIndexed: boolean }>;
  reindexPDFFromCitation: (citationId: string) => Promise<void>;
  getDocumentIdForCitation: (citationId: string) => Promise<string | null>;
  indexAllPDFs: () => Promise<{ indexed: number; skipped: number; errors: string[] }>;
  refreshIndexedPDFs: () => Promise<void>;
  isFileIndexed: (filePath: string) => boolean;
  isBibtexKeyIndexed: (bibtexKey: string) => boolean;
  downloadAndIndexZoteroPDF: (citationId: string, attachmentKey: string, projectPath: string) => Promise<void>;
  downloadAllMissingPDFs: (projectPath: string) => Promise<{ downloaded: number; skipped: number; errors: string[] }>;

  // Internal
  applyFilters: () => void;
}

// MARK: - Store

export const useBibliographyStore = create<BibliographyState>((set, get) => ({
  citations: [],
  filteredCitations: [],
  selectedCitationId: null,
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
  searchQuery: '',
  sortBy: 'author',
  sortOrder: 'asc',
  selectedTags: [],

  loadBibliography: async (filePath: string) => {
    try {
      const result = await window.electron.bibliography.load(filePath);

      if (result.success && Array.isArray(result.citations)) {
        set({
          citations: result.citations,
          filteredCitations: result.citations,
        });

        get().applyFilters();

        // Immediately refresh indexed PDFs state to avoid race condition
        await get().refreshIndexedPDFs();
      } else {
        console.error('Invalid response from bibliography.load:', result);
        throw new Error(result.error || 'Failed to load bibliography');
      }
    } catch (error) {
      console.error('Failed to load bibliography:', error);
      throw error;
    }
  },

  loadBibliographyWithMetadata: async (filePath: string, projectPath: string) => {
    try {
      const result = await window.electron.bibliography.loadWithMetadata({
        filePath,
        projectPath,
      });

      if (result.success && Array.isArray(result.citations)) {
        // Count citations with zotero metadata
        const withZotero = result.citations.filter(
          (c: Citation) => c.zoteroAttachments && c.zoteroAttachments.length > 0
        ).length;
        console.log(`📚 Loaded ${result.citations.length} citations (${withZotero} with Zotero metadata)`);

        set({
          citations: result.citations,
          filteredCitations: result.citations,
        });

        get().applyFilters();

        // Immediately refresh indexed PDFs state to avoid race condition
        // This ensures indexedFilePaths is populated before UI components render
        try {
          console.log('🔄 About to call refreshIndexedPDFs from loadBibliographyWithMetadata...');
          await get().refreshIndexedPDFs();
          console.log('✅ refreshIndexedPDFs completed');
        } catch (refreshError) {
          console.error('⚠️ refreshIndexedPDFs failed (non-blocking):', refreshError);
          // Don't throw - this is non-blocking, the bibliography is still loaded
        }
      } else {
        console.error('Invalid response from bibliography.loadWithMetadata:', result);
        throw new Error(result.error || 'Failed to load bibliography with metadata');
      }
    } catch (error) {
      console.error('Failed to load bibliography with metadata:', error);
      throw error;
    }
  },

  mergeBibliography: async (filePath: string) => {
    try {
      const result = await window.electron.bibliography.load(filePath);

      if (!result.success || !Array.isArray(result.citations)) {
        console.error('Invalid response from bibliography.load:', result);
        throw new Error(result.error || 'Failed to load bibliography');
      }

      const { citations: currentCitations } = get();
      const newCitationsFromFile = result.citations;

      // Build a Set of existing citation IDs for fast lookup
      const existingIds = new Set(currentCitations.map(c => c.id));

      // Separate new citations from duplicates
      const newCitations: Citation[] = [];
      let duplicatesCount = 0;

      newCitationsFromFile.forEach((citation: Citation) => {
        if (existingIds.has(citation.id)) {
          duplicatesCount++;
          console.log(`🔄 Duplicate found: ${citation.id} - ${citation.title}`);
        } else {
          newCitations.push(citation);
        }
      });

      // Merge: existing + new (no duplicates)
      const mergedCitations = [...currentCitations, ...newCitations];

      console.log(`✅ Bibliography merge complete:`, {
        existing: currentCitations.length,
        fromFile: newCitationsFromFile.length,
        newAdded: newCitations.length,
        duplicates: duplicatesCount,
        total: mergedCitations.length,
      });

      set({
        citations: mergedCitations,
        filteredCitations: mergedCitations,
      });

      get().applyFilters();

      return {
        newCitations: newCitations.length,
        duplicates: duplicatesCount,
        total: mergedCitations.length,
      };
    } catch (error) {
      console.error('Failed to merge bibliography:', error);
      throw error;
    }
  },

  searchCitations: (query: string) => {
    set({ searchQuery: query });
    get().applyFilters();
  },

  setSortBy: (field: 'author' | 'year' | 'title') => {
    set({ sortBy: field });
    get().applyFilters();
  },

  toggleSortOrder: () => {
    set((state) => ({
      sortOrder: state.sortOrder === 'asc' ? 'desc' : 'asc',
    }));
    get().applyFilters();
  },

  applyFilters: () => {
    const { citations, searchQuery, sortBy, sortOrder, selectedTags } = get();

    // Filter by search query
    let filtered = citations;

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = citations.filter(
        (citation) =>
          citation.author.toLowerCase().includes(query) ||
          citation.title.toLowerCase().includes(query) ||
          citation.year.includes(query) ||
          (citation.tags && citation.tags.some(tag => tag.toLowerCase().includes(query))) ||
          (citation.keywords && citation.keywords.toLowerCase().includes(query)) ||
          (citation.notes && citation.notes.toLowerCase().includes(query))
      );
    }

    // Filter by tags
    if (selectedTags.length > 0) {
      filtered = filtered.filter(citation =>
        citation.tags && citation.tags.some(tag => selectedTags.includes(tag))
      );
    }

    // Sort
    filtered = [...filtered].sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'author':
          comparison = a.author.localeCompare(b.author);
          break;
        case 'year':
          comparison = a.year.localeCompare(b.year);
          break;
        case 'title':
          comparison = a.title.localeCompare(b.title);
          break;
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    set({ filteredCitations: filtered });
  },

  selectCitation: (citationId: string) => {
    set({ selectedCitationId: citationId });
  },

  insertCitation: (citationId: string) => {
    const { citations } = get();
    const citation = citations.find((c) => c.id === citationId);

    if (!citation) return;

    // Use the actual BibTeX key from the citation id
    const citationText = `[@${citation.id}]`;

    console.log('📝 Inserting citation:', citationText, 'for', citation.title);

    // Call IPC to insert citation into editor
    window.electron.editor.insertText(citationText);
  },

  // Tags & metadata methods
  updateCitationMetadata: (citationId: string, updates: Partial<Citation>) => {
    set((state) => ({
      citations: state.citations.map((citation) =>
        citation.id === citationId
          ? { ...citation, ...updates }
          : citation
      ),
    }));
    get().applyFilters();
  },

  getAllTags: () => {
    const { citations } = get();
    const tagsSet = new Set<string>();
    citations.forEach((citation) => {
      if (citation.tags) {
        citation.tags.forEach((tag) => tagsSet.add(tag));
      }
    });
    return Array.from(tagsSet).sort();
  },

  setTagsFilter: (tags: string[]) => {
    set({ selectedTags: tags });
    get().applyFilters();
  },

  clearTagsFilter: () => {
    set({ selectedTags: [] });
    get().applyFilters();
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

    // Get citations with PDFs that are not yet indexed
    const citationsWithPDFs = citations.filter(
      (c) => c.file && !get().indexedFilePaths.has(c.file)
    );

    if (citationsWithPDFs.length === 0) {
      return { indexed: 0, skipped: 0, errors: [] };
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

  downloadAndIndexZoteroPDF: async (citationId: string, attachmentKey: string, projectPath: string) => {
    try {
      const { citations } = get();
      const citation = citations.find((c) => c.id === citationId);

      if (!citation) {
        throw new Error('Citation not found');
      }

      const attachment = citation.zoteroAttachments?.find((att) => att.key === attachmentKey);
      if (!attachment) {
        throw new Error('Attachment not found in citation');
      }

      // Get Zotero credentials from global config (userId, apiKey only)
      const zoteroConfig = await window.electron.config.get('zotero');
      if (!zoteroConfig || !zoteroConfig.userId || !zoteroConfig.apiKey) {
        throw new Error('Zotero not configured. Please configure Zotero in Settings.');
      }

      // Get groupId from project config (not global config)
      let groupId: string | undefined;
      try {
        const projectConfig = await window.electron.project.getConfig(`${projectPath}/project.json`);
        groupId = projectConfig?.zotero?.groupId || undefined;
        console.log(`📁 Using project groupId for download: ${groupId || '(personal library)'}`);
      } catch (configError) {
        console.warn('⚠️ Could not load project config for groupId:', configError);
      }

      console.log(`📥 Downloading PDF from Zotero: ${attachment.filename}`);

      // Download PDF from Zotero
      const downloadResult = await window.electron.zotero.downloadPDF({
        userId: zoteroConfig.userId,
        apiKey: zoteroConfig.apiKey,
        groupId,
        attachmentKey: attachment.key,
        filename: attachment.filename,
        targetDirectory: projectPath,
      });

      if (!downloadResult.success || !downloadResult.filePath) {
        throw new Error(downloadResult.error || 'Failed to download PDF');
      }

      console.log(`✅ PDF downloaded to: ${downloadResult.filePath}`);

      // Update citation with local file path and mark attachment as downloaded
      const updatedCitations = citations.map((c) => {
        if (c.id === citationId) {
          // Also update the zoteroAttachment to mark it as downloaded with local path
          const updatedAttachments = c.zoteroAttachments?.map((att) =>
            att.key === attachmentKey
              ? { ...att, downloaded: true, localPath: downloadResult.filePath }
              : att
          );
          return { ...c, file: downloadResult.filePath, zoteroAttachments: updatedAttachments };
        }
        return c;
      });

      set({ citations: updatedCitations });
      get().applyFilters();

      // Save updated metadata to persist the local file path
      try {
        await window.electron.bibliography.saveMetadata({
          projectPath,
          citations: updatedCitations,
        });
        console.log('💾 Metadata saved after PDF download');
      } catch (metaError) {
        console.error('⚠️ Failed to save metadata after PDF download:', metaError);
      }

      // Index the downloaded PDF
      console.log(`🔍 Indexing downloaded PDF for citation: ${citation.title}`);

      window.dispatchEvent(new CustomEvent('bibliography:indexing-start', {
        detail: { citationId, title: citation.title, filePath: downloadResult.filePath }
      }));

      const bibliographyMetadata = {
        title: citation.title,
        author: citation.author,
        year: citation.year,
      };

      const indexResult = await window.electron.pdf.index(
        downloadResult.filePath!,
        citationId,
        bibliographyMetadata
      );

      if (!indexResult.success) {
        window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
          detail: { citationId, success: false, error: indexResult.error }
        }));
        throw new Error(indexResult.error || 'Failed to index PDF');
      }

      // Add to indexed set
      set((state) => ({
        indexedFilePaths: new Set([...state.indexedFilePaths, downloadResult.filePath!])
      }));

      window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
        detail: { citationId, success: true }
      }));

      console.log(`✅ PDF downloaded and indexed from Zotero: ${citation.title}`);
    } catch (error) {
      console.error('❌ Failed to download and index PDF from Zotero:', error);
      throw error;
    }
  },

  downloadAllMissingPDFs: async (projectPath: string) => {
    try {
      const { citations } = get();

      // Get Zotero credentials from global config (userId, apiKey only)
      const zoteroConfig = await window.electron.config.get('zotero');
      if (!zoteroConfig || !zoteroConfig.userId || !zoteroConfig.apiKey) {
        throw new Error('Zotero not configured. Please configure Zotero in Settings.');
      }

      // Get groupId from project config (not global config)
      let groupId: string | undefined;
      try {
        const projectConfig = await window.electron.project.getConfig(`${projectPath}/project.json`);
        groupId = projectConfig?.zotero?.groupId || undefined;
        console.log(`📁 Using project groupId for batch download: ${groupId || '(personal library)'}`);
      } catch (configError) {
        console.warn('⚠️ Could not load project config for groupId:', configError);
      }

      // Find citations with Zotero PDFs but no local file
      const citationsNeedingPDFs = citations.filter(
        (c) => !c.file && c.zoteroAttachments && c.zoteroAttachments.length > 0
      );

      if (citationsNeedingPDFs.length === 0) {
        return { downloaded: 0, skipped: 0, errors: [] };
      }

      const errors: string[] = [];
      let downloaded = 0;
      let skipped = 0;

      // Update batch indexing state
      set({
        batchIndexing: {
          isIndexing: true,
          current: 0,
          total: citationsNeedingPDFs.length,
          skipped: 0,
          indexed: 0,
          errors: [],
        }
      });

      for (let i = 0; i < citationsNeedingPDFs.length; i++) {
        const citation = citationsNeedingPDFs[i];

        set((state) => ({
          batchIndexing: {
            ...state.batchIndexing,
            current: i + 1,
            currentCitation: {
              citationId: citation.id,
              title: citation.title,
              progress: 0,
              stage: 'Downloading PDF...',
            }
          }
        }));

        try {
          // Download first available PDF (or could show selection dialog for multiple)
          const firstAttachment = citation.zoteroAttachments![0];

          console.log(`📥 Downloading PDF for: ${citation.title}`);

          const downloadResult = await window.electron.zotero.downloadPDF({
            userId: zoteroConfig.userId,
            apiKey: zoteroConfig.apiKey,
            groupId,
            attachmentKey: firstAttachment.key,
            filename: firstAttachment.filename,
            targetDirectory: projectPath,
          });

          if (!downloadResult.success || !downloadResult.filePath) {
            errors.push(`${citation.title}: ${downloadResult.error || 'Failed to download'}`);
            continue;
          }

          // Update citation with local file path
          const updatedCitations = get().citations.map((c) =>
            c.id === citation.id ? { ...c, file: downloadResult.filePath } : c
          );

          set({ citations: updatedCitations });
          get().applyFilters();

          // Index the downloaded PDF
          set((state) => ({
            batchIndexing: {
              ...state.batchIndexing,
              currentCitation: {
                citationId: citation.id,
                title: citation.title,
                progress: 50,
                stage: 'Indexing PDF...',
              }
            }
          }));

          const bibliographyMetadata = {
            title: citation.title,
            author: citation.author,
            year: citation.year,
          };

          const indexResult = await window.electron.pdf.index(
            downloadResult.filePath,
            citation.id,
            bibliographyMetadata
          );

          if (indexResult.success) {
            downloaded++;
            set((state) => ({
              indexedFilePaths: new Set([...state.indexedFilePaths, downloadResult.filePath!]),
              batchIndexing: { ...state.batchIndexing, indexed: downloaded }
            }));
          } else {
            errors.push(`${citation.title}: ${indexResult.error || 'Failed to index'}`);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          errors.push(`${citation.title}: ${errorMsg}`);
        }
      }

      set({
        batchIndexing: {
          isIndexing: false,
          current: citationsNeedingPDFs.length,
          total: citationsNeedingPDFs.length,
          skipped,
          indexed: downloaded,
          errors,
        }
      });

      console.log(`✅ Batch download complete: ${downloaded} downloaded, ${errors.length} errors`);

      return { downloaded, skipped, errors };
    } catch (error) {
      console.error('❌ Failed to download all missing PDFs:', error);
      throw error;
    }
  },
}));
