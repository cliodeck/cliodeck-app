import type { Citation, CitationSliceState, BibliographySliceCreator } from './types';

export const createCitationSlice: BibliographySliceCreator<CitationSliceState> = (set, get) => ({
  citations: [],
  filteredCitations: [],
  selectedCitationId: null,
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
});
