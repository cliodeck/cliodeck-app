import type {
  BibliographyImportOutcome,
  BibliographyProblem,
  Citation,
  CitationSliceState,
  BibliographySliceCreator,
} from './types';
import { referenceTags } from './referenceTags';
import { abstractOf } from './citationAbstract';
import { mergeCitationLists } from '../../../../../backend/core/bibliography/mergeCitations';
import { refusedAsProjectChanged, stillIn } from '../../services/still-in-project';

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

/** Ce que rend le main pour un import dans le projet ouvert. */
interface BibliographyImportResponse extends Omit<BibliographyLoadResponse, 'citations'> {
  bibPath?: string;
  total?: number;
  newCitations?: number;
  duplicates?: number;
  sourceSaved?: boolean;
  sourceError?: string;
  /** Fusion ou remplacement refusés : le `.bib` du projet en cause, et pourquoi. */
  file?: string;
  detail?: string;
}

/**
 * La fusion arrêtée avant d'écrire : le `.bib` du projet ne s'est pas lu en entier (`problem`), ou
 * `project.json` ne dit plus lequel c'est (`problem` nul). Le main n'a rien écrit.
 */
export class BibliographyMergeRefusedError extends Error {
  readonly problem: Extract<BibliographyProblem, { kind: 'partial' | 'unreadable' }> | null;

  constructor(problem: BibliographyMergeRefusedError['problem'], message: string) {
    super(message);
    this.name = 'BibliographyMergeRefusedError';
    this.problem = problem;
  }
}

/**
 * Le remplacement refusé avant d'écrire : dans le projet, le nom du fichier importé est un lien vers
 * un fichier rangé ailleurs, que l'écriture aurait suivi. Le main n'a rien écrit.
 */
export class BibliographyReplaceRefusedError extends Error {
  readonly file: string;

  constructor(file: string, message: string) {
    super(message);
    this.name = 'BibliographyReplaceRefusedError';
    this.file = file;
  }
}

/**
 * L'échec de `bibliography.import` : une fusion ou un remplacement refusés, une source qui ne se lit
 * pas, ou un autre.
 */
function importFailure(sourcePath: string, result: BibliographyImportResponse): Error {
  const file = result.file ?? '';
  if (result.error === 'bib-outside-project') return new BibliographyReplaceRefusedError(file, result.error);
  if (result.error === 'bib-unread') {
    return new BibliographyMergeRefusedError(
      { kind: 'partial', file, unreadKeys: result.unreadKeys ?? [], metadataUnreadable: false },
      result.error
    );
  }
  if (result.error === 'bib-unreadable') {
    return new BibliographyMergeRefusedError(
      { kind: 'unreadable', file, reason: result.reason ?? 'io', detail: result.detail ?? '' },
      result.error
    );
  }
  if (result.error === 'project-unreadable') return new BibliographyMergeRefusedError(null, result.error);
  return loadFailure(sourcePath, result);
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
        // Les notes de lecture et les PDF indexés appartiennent au projet, pas au `.bib` : sans
        // cette relecture, ceux du projet d'avant restaient affichés, et une étiquette ajoutée
        // ici recopiait sur le disque celles de l'autre projet.
        void get().loadReadingNotes();
        try {
          await get().refreshIndexedPDFs();
        } catch (refreshError) {
          console.error('⚠️ refreshIndexedPDFs failed (non-blocking):', refreshError);
        }
        throw new Error(result.error || 'Failed to load bibliography with metadata');
      }
    } catch (error) {
      console.error('Failed to load bibliography with metadata:', error);
      throw error;
    }
  },

  importBibliography: async (sourcePath, mode, projectPath): Promise<BibliographyImportOutcome | null> => {
    const file = fileName(sourcePath);

    // Sans projet, rien à écrire : le fichier remplace la liste du panneau, ou la rejoint.
    if (!projectPath) {
      if (mode === 'replace') {
        await get().loadBibliography(sourcePath);
        const problem = get().bibliographyProblem;
        const unreadKeys = problem?.kind === 'partial' ? problem.unreadKeys : [];
        return { total: get().citations.length, newCitations: 0, duplicates: 0, unreadKeys, file, sourceSaved: true };
      }
      const result: BibliographyLoadResponse = await window.electron.bibliography.load(sourcePath);
      if (!result.success || !Array.isArray(result.citations)) throw loadFailure(sourcePath, result);
      const { merged, newCount, duplicates } = mergeCitationLists(get().citations, result.citations);
      set({ citations: merged, filteredCitations: merged });
      get().applyFilters();
      return {
        total: merged.length,
        newCitations: newCount,
        duplicates,
        unreadKeys: result.unreadKeys ?? [],
        file,
        sourceSaved: true,
      };
    }

    // Le main écrit le `.bib` du projet et le relit : le panneau n'a rien touché avant sa réponse.
    const result: BibliographyImportResponse = await window.electron.bibliography.import({
      sourcePath,
      mode,
      expectedProjectPath: projectPath,
    });
    // Refusé par le main, ou le projet a changé pendant l'écriture : rien ne s'affiche dans l'autre.
    if (refusedAsProjectChanged(result) || !(await stillIn(projectPath))) return null;
    if (!result.success || !result.bibPath) throw importFailure(sourcePath, result);

    // Le panneau se relit depuis le fichier du projet, rattachements Zotero compris.
    await get().loadBibliographyWithMetadata(result.bibPath, projectPath);
    if (!(await stillIn(projectPath))) return null;
    return {
      total: result.total ?? get().citations.length,
      newCitations: result.newCitations ?? 0,
      duplicates: result.duplicates ?? 0,
      unreadKeys: result.unreadKeys ?? [],
      file,
      sourceSaved: result.sourceSaved === true,
      ...(result.sourceError ? { sourceError: result.sourceError } : {}),
    };
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
          (citation.notes && citation.notes.toLowerCase().includes(query)) ||
          (abstractOf(citation)?.toLowerCase().includes(query) ?? false)
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
