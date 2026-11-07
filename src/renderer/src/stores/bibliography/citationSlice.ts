import type { BibliographyProblem, Citation, CitationSliceState, BibliographySliceCreator } from './types';
import { referenceTags } from './referenceTags';

/** Un fichier qui ne s'est pas lu du tout. */
type UnreadFileProblem = Extract<BibliographyProblem, { kind: 'missing' | 'unreadable' }>;

/** Ce que rend le main pour un `.bib` : les citations, et ce qui ne s'est pas lu. */
interface BibliographyLoadResponse {
  success?: boolean;
  error?: string;
  citations?: Citation[];
  unreadKeys?: string[];
  metadataUnreadable?: boolean;
  problem?: 'missing' | 'unreadable';
  reason?: string;
}

const fileName = (filePath: string): string => filePath.split(/[\\/]/).pop() || filePath;

/** Le fichier s'est lu : des entrées ou des métadonnées ont pu manquer. */
function partialProblem(filePath: string, result: BibliographyLoadResponse): BibliographyProblem | null {
  const unreadKeys = result.unreadKeys ?? [];
  const metadataUnreadable = result.metadataUnreadable === true;
  if (unreadKeys.length === 0 && !metadataUnreadable) return null;
  return { kind: 'partial', file: fileName(filePath), unreadKeys, metadataUnreadable };
}

/** Le fichier ne s'est pas lu du tout. */
function failureProblem(filePath: string, result: BibliographyLoadResponse | undefined): UnreadFileProblem {
  if (result?.problem === 'missing') return { kind: 'missing', file: fileName(filePath) };
  return { kind: 'unreadable', file: fileName(filePath), reason: result?.reason ?? 'io', detail: result?.error ?? '' };
}

/**
 * Un `.bib` demandé (à l'import) qui ne s'est pas lu : absent ou illisible, avec sa raison, pour
 * que le message dise quoi faire dans la langue de l'interface (« enregistrez-le en UTF-8 »),
 * au lieu du texte brut du main.
 */
export class BibliographyFileError extends Error {
  readonly problem: UnreadFileProblem;

  constructor(problem: UnreadFileProblem, message: string) {
    super(message);
    this.name = 'BibliographyFileError';
    this.problem = problem;
  }
}

/** L'échec de `bibliography.load` : celui d'un fichier qui ne se lit pas, ou un autre. */
function loadFailure(filePath: string, result: BibliographyLoadResponse | undefined): Error {
  const message = result?.error || 'Failed to load bibliography';
  return result?.problem ? new BibliographyFileError(failureProblem(filePath, result), message) : new Error(message);
}

export const createCitationSlice: BibliographySliceCreator<CitationSliceState> = (set, get) => ({
  citations: [],
  bibliographyProblem: null,
  filteredCitations: [],
  selectedCitationId: null,
  searchQuery: '',
  sortBy: 'author',
  sortOrder: 'asc',
  selectedTags: [],

  loadBibliography: async (filePath: string) => {
    try {
      const result: BibliographyLoadResponse = await window.electron.bibliography.load(filePath);

      if (result.success && Array.isArray(result.citations)) {
        set({
          citations: result.citations,
          filteredCitations: result.citations,
          bibliographyProblem: partialProblem(filePath, result),
        });

        get().applyFilters();

        // Immediately refresh indexed PDFs state to avoid race condition
        await get().refreshIndexedPDFs();
      } else {
        console.error('Invalid response from bibliography.load:', result);
        throw loadFailure(filePath, result);
      }
    } catch (error) {
      console.error('Failed to load bibliography:', error);
      throw error;
    }
  },

  loadBibliographyWithMetadata: async (filePath: string, projectPath: string) => {
    try {
      const result: BibliographyLoadResponse = await window.electron.bibliography.loadWithMetadata({
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
          bibliographyProblem: partialProblem(filePath, result),
        });

        get().applyFilters();

        // Étiquettes du projet : elles vivent dans les notes de lecture.
        void get().loadReadingNotes();

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
        // Le fichier attendu ne se lit pas : ni la liste du projet d'avant, ni un panneau vide
        // sans explication (S07-1-11).
        set({ citations: [], filteredCitations: [], bibliographyProblem: failureProblem(filePath, result) });
        throw new Error(result.error || 'Failed to load bibliography with metadata');
      }
    } catch (error) {
      console.error('Failed to load bibliography with metadata:', error);
      throw error;
    }
  },

  mergeBibliography: async (filePath: string) => {
    try {
      const result: BibliographyLoadResponse = await window.electron.bibliography.load(filePath);

      if (!result.success || !Array.isArray(result.citations)) {
        console.error('Invalid response from bibliography.load:', result);
        throw loadFailure(filePath, result);
      }

      const { citations: currentCitations } = get();
      const newCitationsFromFile = result.citations;

      // Un doublon, c'est le même item Zotero — pas la même clé BibTeX.
      // Deux œuvres distinctes peuvent partager une clé (trois ouvrages en
      // `Unknown_2022`, mesuré) : déduire le doublon de l'`id` en écartait
      // alors une à l'import. Le `zoteroKey` fait foi quand il existe.
      const existingZoteroKeys = new Set(
        currentCitations.map(c => c.zoteroKey).filter(Boolean) as string[]
      );
      const existingIds = new Set(currentCitations.map(c => c.id));

      // Separate new citations from duplicates
      const newCitations: Citation[] = [];
      let duplicatesCount = 0;

      newCitationsFromFile.forEach((citation: Citation) => {
        const isDuplicate = citation.zoteroKey
          ? existingZoteroKeys.has(citation.zoteroKey)
          : existingIds.has(citation.id);

        if (isDuplicate) {
          duplicatesCount++;
          console.log(`🔄 Duplicate found: ${citation.id} - ${citation.title}`);
        } else {
          newCitations.push(citation);
          if (citation.zoteroKey) existingZoteroKeys.add(citation.zoteroKey);
          existingIds.add(citation.id);
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
    const { citations, searchQuery, sortBy, sortOrder, selectedTags, readingNotes, showAutomaticZoteroTags } = get();
    const tagsOf = (citation: Citation) => referenceTags(citation, readingNotes, showAutomaticZoteroTags);

    // Filter by search query
    let filtered = citations;

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = citations.filter(
        (citation) =>
          citation.author.toLowerCase().includes(query) ||
          (citation.editor?.toLowerCase().includes(query) ?? false) ||
          citation.title.toLowerCase().includes(query) ||
          citation.year.includes(query) ||
          tagsOf(citation).some(tag => tag.toLowerCase().includes(query)) ||
          (citation.keywords && citation.keywords.toLowerCase().includes(query)) ||
          (citation.notes && citation.notes.toLowerCase().includes(query))
      );
    }

    // Filter by tags
    if (selectedTags.length > 0) {
      filtered = filtered.filter(citation =>
        tagsOf(citation).some(tag => selectedTags.includes(tag))
      );
    }

    // Sort
    filtered = [...filtered].sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'author':
          // Un ouvrage dirigé n'a pas d'auteur : il se range sous le nom
          // de son directeur, pas en tête de liste sous une chaîne vide.
          comparison = (a.author || a.editor || '').localeCompare(b.author || b.editor || '');
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

  // Tags
  getAllTags: () => {
    // Tags Zotero (sans les automatiques, sauf demande), tags du fichier et
    // étiquettes du projet : ce sur quoi le filtre peut porter.
    const { citations, readingNotes, showAutomaticZoteroTags } = get();
    const tagsSet = new Set<string>();
    citations.forEach((citation) => {
      referenceTags(citation, readingNotes, showAutomaticZoteroTags).forEach((tag) => tagsSet.add(tag));
    });
    return Array.from(tagsSet).sort((a, b) => a.localeCompare(b));
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
