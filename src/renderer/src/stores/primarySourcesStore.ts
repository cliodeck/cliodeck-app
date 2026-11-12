import { create } from 'zustand';
import type { TropySyncIssue } from '@backend/integrations/tropy/TropySync';
import { transcriptionSourceOfFormat } from '@backend/integrations/tropy/transcription-provenance';
import { projectLifecycle } from '../lifecycle/projectLifecycle';

// MARK: - Types

export interface PrimarySourcePhoto {
  id: number;
  path: string;
  filename: string;
  width?: number;
  height?: number;
  hasTranscription: boolean;
  transcription?: string;
}

export interface PrimarySource {
  id: string;
  tropyId: number;
  title: string;
  date?: string;
  creator?: string;
  archive?: string;
  collection?: string;
  type?: string;
  tags: string[];
  transcription?: string;
  transcriptionSource?: TranscriptionWriteSource | 'tropy-notes';
  /**
   * L'OCR de la source est à reprendre : 'poppler', il manquait Poppler pour
   * ses PDF ; 'pages', ses pages ont changé dans Tropy depuis l'OCR (G3).
   */
  ocrPending?: 'poppler' | 'pages';
  photoCount: number;
  lastModified: string;
  indexedAt: string;
}

export interface TropyProjectInfo {
  name: string;
  itemCount: number;
  lastModified: string;
  isWatching: boolean;
  tpyPath?: string | null;
}

export interface SyncProgress {
  phase: 'reading' | 'processing' | 'extracting-entities' | 'indexing' | 'done';
  current: number;
  total: number;
  currentItem?: string;
}

/**
 * Bilan d'une passe de synchronisation. `transcriptionsWritten` était calculé
 * côté main puis jeté ici : après des heures d'OCR, la modale se refermait
 * sans rien dire, y compris quand la passe n'avait rien écrit.
 */
export interface SyncOutcome {
  success: boolean;
  newItems?: number;
  updatedItems?: number;
  ocrPerformed?: number;
  transcriptionsWritten?: number;
  errors?: string[];
  /** Ce qui a empêché la passe, à dire à l'utilisateur (`describeSyncIssue`). */
  issues?: TropySyncIssue[];
}

/**
 * La provenance d'une transcription écrite depuis l'interface : OCR manuel
 * d'une carte ('tesseract'), import d'un fichier ('transkribus' ou
 * 'imported'), saisie ('manual').
 */
export type TranscriptionWriteSource = 'tesseract' | 'transkribus' | 'manual' | 'imported';

/** Pourquoi une transcription écrite n'est pas encore citée par l'assistant. */
export type NotIndexedReason = 'embedding-failed' | 'no-embedding-provider' | 'embedding-space-changed';

/**
 * Ce qu'est devenue une transcription envoyée au main. `success` : elle est
 * écrite. `notIndexed` : écrite mais pas indexée, l'assistant ne la cite pas
 * avant la prochaine synchronisation — jamais un succès sans réserve.
 * `code` : pourquoi rien n'a été écrit.
 */
export interface TranscriptionWriteResult {
  success: boolean;
  notIndexed?: NotIndexedReason;
  code?: 'source-not-found';
  error?: string;
}

export interface PrimarySourcesStatistics {
  sourceCount: number;
  chunkCount: number;
  photoCount: number;
  withTranscription: number;
  withoutTranscription: number;
  byArchive: Record<string, number>;
  byCollection: Record<string, number>;
  tags: string[];
}

interface PrimarySourcesState {
  // Sources
  sources: PrimarySource[];
  filteredSources: PrimarySource[];
  selectedSourceId: string | null;

  // TPY Project
  tpyPath: string | null;
  projectInfo: TropyProjectInfo | null;

  // Sync state
  isSyncing: boolean;
  syncProgress: SyncProgress | null;

  // OCR state
  isPerformingOCR: boolean;
  ocrProgress: { current: number; total: number } | null;
  /** Langue OCR courante — partagée entre la synchro (modale OCR) et
   *  l'OCR manuel par source (#23). */
  ocrLanguage: string;

  // Search & filters
  searchQuery: string;
  selectedTags: string[];
  selectedArchive: string | null;
  selectedCollection: string | null;

  // Statistics
  statistics: PrimarySourcesStatistics | null;

  /**
   * Ce que la dernière synchro n'a pas pu faire sans être refusée — des
   * sources enregistrées mais pas encore indexées. Le panneau l'affiche
   * jusqu'à la synchro suivante, sans alerte : c'est un état qui peut durer.
   */
  syncIssues: TropySyncIssue[];

  /**
   * Avance à chaque écriture de transcription (OCR manuel, import, synchro) :
   * le rapport OCR de la source sélectionnée se relit dessus, il ne se
   * relisait qu'au changement de source (S18-2-6).
   */
  transcriptionRevision: number;

  // OCR Languages
  availableOCRLanguages: Array<{ code: string; name: string }>;

  /**
   * Rend l'état initial : rien du projet ClioDeck précédent ne reste (S18-1-30),
   * et une lecture lancée avant ne réécrit plus rien. Ne touche ni aux opérations
   * en vol (`isSyncing`, OCR), que leur propre fin referme, ni aux réglages de
   * l'application (langue OCR, langues disponibles). Appelé au changement de
   * projet (registre du projet), pour un projet sans Tropy et après une purge.
   */
  reset: () => void;

  // Actions - Project
  openTPYProject: (
    tpyPath: string
  ) => Promise<{ success: boolean; error?: string; issue?: TropySyncIssue }>;
  getProjectInfo: () => Promise<void>;

  // Actions - Sync
  syncTPY: (options: {
    performOCR: boolean;
    ocrLanguage: string;
    transcriptionDirectory?: string;
    forceReindex?: boolean;
  }) => Promise<SyncOutcome>;
  checkSyncNeeded: () => Promise<boolean>;

  // Actions - Watching
  startWatching: () => Promise<void>;
  stopWatching: () => Promise<void>;

  // Actions - OCR
  /** `write` : ce qu'est devenue la transcription reconnue, si l'OCR a abouti. */
  performOCR: (
    sourceId: string,
    imagePaths: string[],
    language: string
  ) => Promise<{ success: boolean; text?: string; write?: TranscriptionWriteResult }>;
  /** OCR manuel d'une source (#23) : résout les photos côté main puis
   *  délègue à performOCR avec la langue courante. */
  performManualOCR: (sourceId: string) => Promise<{
    success: boolean;
    error?: 'no-photos' | 'failed' | 'not-saved' | 'source-not-found';
    notIndexed?: NotIndexedReason;
  }>;
  setOCRLanguage: (language: string) => void;
  /** `code` : l'écriture a échoué ('not-saved'), ou la source n'est plus en base. */
  importTranscription: (sourceId: string, filePath: string) => Promise<{
    success: boolean;
    error?: string;
    code?: 'source-not-found' | 'not-saved';
    notIndexed?: NotIndexedReason;
  }>;
  loadOCRLanguages: () => Promise<void>;

  // Actions - Sources
  refreshSources: () => Promise<void>;
  selectSource: (sourceId: string | null) => void;
  getSource: (sourceId: string) => Promise<PrimarySource | null>;
  /** La carte ne doit pas annoncer un succès quand l'écriture a échoué, ni sans réserve quand l'indexation manque. */
  updateTranscription: (
    sourceId: string,
    transcription: string,
    source: TranscriptionWriteSource,
    confidence?: number
  ) => Promise<TranscriptionWriteResult>;

  // Actions - Search & Filters
  searchSources: (query: string) => void;
  setTagsFilter: (tags: string[]) => void;
  setArchiveFilter: (archive: string | null) => void;
  setCollectionFilter: (collection: string | null) => void;
  clearFilters: () => void;

  // Actions - Statistics
  refreshStatistics: () => Promise<void>;

  // Internal
  applyFilters: () => void;
}

// MARK: - Store

/** Ce qui appartient au projet ClioDeck ouvert, et que `reset` vide. */
const EMPTY_PROJECT_STATE = {
  sources: [],
  filteredSources: [],
  selectedSourceId: null,
  tpyPath: null,
  projectInfo: null,
  searchQuery: '',
  selectedTags: [],
  selectedArchive: null,
  selectedCollection: null,
  statistics: null,
  syncIssues: [],
} satisfies Partial<PrimarySourcesState>;

/**
 * Change à chaque `reset` : une lecture n'écrit sa réponse que si aucun reset
 * n'a eu lieu depuis son départ. Sans cela, la réponse d'une lecture lancée
 * pour le projet A, arrivée après le passage à B, y réécrivait l'état de A.
 */
let generation = 0;

export const usePrimarySourcesStore = create<PrimarySourcesState>((set, get) => ({
  // Initial state
  ...EMPTY_PROJECT_STATE,
  transcriptionRevision: 0,
  isSyncing: false,
  syncProgress: null,
  isPerformingOCR: false,
  ocrProgress: null,
  ocrLanguage: 'fra',
  availableOCRLanguages: [],

  reset: () => {
    generation += 1;
    set({ ...EMPTY_PROJECT_STATE });
  },

  // MARK: - Project Actions

  openTPYProject: async (tpyPath: string) => {
    try {
      const result = await window.electron.tropy.openProject(tpyPath);

      if (result.success) {
        set({
          tpyPath,
          projectInfo: {
            name: result.projectName || 'Unknown',
            itemCount: result.itemCount || 0,
            lastModified: result.lastModified || new Date().toISOString(),
            isWatching: false,
          },
        });

        // Sync automatique après ouverture
        await get().syncTPY({
          performOCR: false,
          ocrLanguage: 'fra',
        });

        return { success: true };
      }

      // Refus (autre projet Tropy, Q25) : rien n'est suivi ni synchronisé.
      return { success: false, error: result.error, issue: result.issue };
    } catch (error: unknown) {
      console.error('Failed to open TPY project:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  getProjectInfo: async () => {
    const startedAt = generation;
    try {
      const result = await window.electron.tropy.getProjectInfo();
      if (startedAt !== generation) return;
      if (result.success && result.info) {
        // Restaurer aussi le tpyPath depuis les infos du projet
        set({
          projectInfo: result.info,
          tpyPath: result.info.tpyPath || null,
        });
      } else if (result.success) {
        // Pas de projet Tropy : celui du projet précédent ne reste pas affiché,
        // et son chemin ne repart pas vers le main (S18-1-30).
        get().reset();
      }
    } catch (error) {
      console.error('Failed to get project info:', error);
    }
  },

  // MARK: - Sync Actions

  syncTPY: async (options) => {
    // Prevent concurrent syncs
    if (get().isSyncing) {
      console.warn('⚠️ Sync already in progress, skipping');
      return { success: false, errors: ['Sync already in progress'] };
    }

    set({ isSyncing: true, syncProgress: null });
    const startedAt = generation;

    // Setup progress listener
    const unsubscribe = window.electron.tropy.onSyncProgress((progress) => {
      set({ syncProgress: progress });
    });

    try {
      const result = await window.electron.tropy.sync(options);
      // Le bilan d'une passe lancée pour un autre projet ne s'affiche pas ici.
      if (startedAt === generation) set({ syncIssues: result.issues ?? [] });

      if (result.success) {
        set((state) => ({ transcriptionRevision: state.transcriptionRevision + 1 }));
        // Refresh sources after sync
        await get().refreshSources();
        await get().refreshStatistics();
        await get().getProjectInfo();

        // Une passe réussie a aussi ses problèmes : des sources enregistrées
        // mais pas encore indexées. Ils étaient jetés ici.
        return {
          success: true,
          newItems: result.newItems,
          updatedItems: result.updatedItems,
          ocrPerformed: result.ocrPerformed,
          transcriptionsWritten: result.transcriptionsWritten,
          errors: result.errors,
          issues: result.issues,
        };
      }

      return { success: false, errors: result.errors, issues: result.issues };
    } catch (error: unknown) {
      console.error('Sync failed:', error);
      return { success: false, errors: [error instanceof Error ? error.message : String(error)] };
    } finally {
      unsubscribe();
      set({ isSyncing: false, syncProgress: null });
    }
  },

  checkSyncNeeded: async () => {
    try {
      const result = await window.electron.tropy.checkSyncNeeded();
      return result.needed || false;
    } catch {
      return false;
    }
  },

  // MARK: - Watching Actions

  startWatching: async () => {
    try {
      // Aucun chemin envoyé : le main surveille le projet Tropy lié au projet
      // courant. Il adoptait celui qu'on lui passait, et un `tpyPath` resté du
      // projet précédent devenait le projet Tropy de celui-ci (S18-1-30).
      const result = await window.electron.tropy.startWatching();
      if (!result?.success) {
        console.error('Failed to start watching:', result?.error);
        return;
      }
      set((state) => ({
        projectInfo: state.projectInfo
          ? { ...state.projectInfo, isWatching: true }
          : null,
      }));

      // Setup file change listener
      window.electron.tropy.onFileChanged(async (changedPath) => {
        console.log('TPY file changed:', changedPath);
        // Auto-sync on file change
        await get().syncTPY({
          performOCR: false,
          ocrLanguage: 'fra',
        });
      });
    } catch (error) {
      console.error('Failed to start watching:', error);
    }
  },

  stopWatching: async () => {
    try {
      await window.electron.tropy.stopWatching();
      set((state) => ({
        projectInfo: state.projectInfo
          ? { ...state.projectInfo, isWatching: false }
          : null,
      }));
    } catch (error) {
      console.error('Failed to stop watching:', error);
    }
  },

  // MARK: - OCR Actions

  performOCR: async (sourceId: string, imagePaths: string[], language: string) => {
    set({ isPerformingOCR: true, ocrProgress: { current: 0, total: imagePaths.length } });

    try {
      const result = await window.electron.tropy.performBatchOCR(imagePaths, language);

      if (result.success && result.text) {
        // L'OCR a réussi, mais l'ÉCRITURE peut échouer : annoncer un succès
        // sans le vérifier laissait croire que la transcription était
        // enregistrée alors que rien ne l'avait été. Un texte de Tesseract,
        // avec sa confiance : il était enregistré comme saisie manuelle.
        const write = await get().updateTranscription(sourceId, result.text, 'tesseract', result.confidence);
        if (!write.success) return { success: false, write };

        return { success: true, text: result.text, write };
      }

      return { success: false };
    } catch (error: unknown) {
      console.error('OCR failed:', error);
      return { success: false };
    } finally {
      set({ isPerformingOCR: false, ocrProgress: null });
    }
  },

  performManualOCR: async (sourceId: string) => {
    try {
      const photosRes = await window.electron.tropy.getSourcePhotos(sourceId);
      // Les photos n'ont pas pu être lues dans Tropy (J6) : ce n'est pas
      // « aucune image trouvée (fichiers déplacés ou manquants) ».
      if (!photosRes.success) {
        return { success: false, error: 'failed' as const };
      }
      if (!photosRes.paths || photosRes.paths.length === 0) {
        return { success: false, error: 'no-photos' as const };
      }
      const result = await get().performOCR(sourceId, photosRes.paths, get().ocrLanguage);
      if (result.success) {
        return result.write?.notIndexed ? { success: true, notIndexed: result.write.notIndexed } : { success: true };
      }
      // Reconnu mais pas enregistré : ce n'est pas « l'OCR a échoué ».
      if (result.write) {
        return {
          success: false,
          error: result.write.code === 'source-not-found' ? ('source-not-found' as const) : ('not-saved' as const),
        };
      }
      return { success: false, error: 'failed' as const };
    } catch (error) {
      console.error('Manual OCR failed:', error);
      return { success: false, error: 'failed' as const };
    }
  },

  setOCRLanguage: (language: string) => {
    set({ ocrLanguage: language });
  },

  importTranscription: async (sourceId: string, filePath: string) => {
    try {
      const result = await window.electron.tropy.importTranscription(filePath);

      if (result.success && result.text) {
        // Le résultat de l'écriture était ignoré : « importée » s'affichait
        // même quand rien n'avait été écrit (S15-1-8).
        const write = await get().updateTranscription(sourceId, result.text, transcriptionSourceOfFormat(result.format));
        if (!write.success) {
          return { success: false, error: write.error, code: write.code ?? ('not-saved' as const) };
        }
        return write.notIndexed ? { success: true, notIndexed: write.notIndexed } : { success: true };
      }

      return { success: false, error: result.error };
    } catch (error: unknown) {
      console.error('Import transcription failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  loadOCRLanguages: async () => {
    try {
      const result = await window.electron.tropy.getOCRLanguages();
      if (result.success && result.languages) {
        set({ availableOCRLanguages: result.languages });
      }
    } catch (error) {
      console.error('Failed to load OCR languages:', error);
    }
  },

  // MARK: - Sources Actions

  refreshSources: async () => {
    const startedAt = generation;
    try {
      const result = await window.electron.tropy.getAllSources();
      if (startedAt !== generation) return;

      if (result.success && result.sources) {
        const sources: PrimarySource[] = result.sources.map((s: Partial<PrimarySource>) => ({
          id: s.id ?? '',
          tropyId: s.tropyId,
          title: s.title ?? '',
          date: s.date,
          creator: s.creator,
          archive: s.archive,
          collection: s.collection,
          type: s.type ?? 'document',
          tags: [],
          transcription: s.transcription,
          transcriptionSource: s.transcriptionSource,
          ocrPending: s.ocrPending,
          photoCount: 0,
          lastModified: s.lastModified,
          indexedAt: s.indexedAt,
        }));

        set({ sources });
        get().applyFilters();
      }
    } catch (error) {
      console.error('Failed to refresh sources:', error);
    }
  },

  selectSource: (sourceId: string | null) => {
    set({ selectedSourceId: sourceId });
  },

  getSource: async (sourceId: string) => {
    try {
      const result = await window.electron.tropy.getSource(sourceId);
      return result.source || null;
    } catch {
      return null;
    }
  },

  updateTranscription: async (sourceId, transcription, source, confidence) => {
    // Le résultat était AWAITÉ sans être lu : `updateSourceTranscription`
    // rend `{success:false}` sans lever, si bien que la carte affichait une
    // réussite alors que rien n'avait été écrit.
    try {
      const result = await window.electron.tropy.updateTranscription(
        sourceId,
        transcription,
        source,
        confidence
      );
      if (!result?.success) {
        console.error('Transcription non écrite:', result?.error);
        return {
          success: false,
          error: result?.error,
          ...(result?.code === 'source-not-found' && { code: 'source-not-found' as const }),
        };
      }
      // Écrite : le rapport OCR et les compteurs « avec / sans transcription »
      // ne se relisaient pas (S18-2-6).
      set((state) => ({ transcriptionRevision: state.transcriptionRevision + 1 }));
      await get().refreshSources();
      await get().refreshStatistics();
      // Écrite mais pas réindexée : à dire, pas à taire (S08-1-30).
      if (result.reindexError || result.reindexCode) {
        console.warn('Transcription écrite, pas encore indexée:', result.reindexError);
        const notIndexed: NotIndexedReason =
          result.reindexCode === 'no-embedding-provider' || result.reindexCode === 'embedding-space-changed'
            ? result.reindexCode
            : 'embedding-failed';
        return { success: true, notIndexed };
      }
      return { success: true };
    } catch (error) {
      console.error('Failed to update transcription:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  // MARK: - Search & Filters Actions

  searchSources: (query: string) => {
    set({ searchQuery: query });
    get().applyFilters();
  },

  setTagsFilter: (tags: string[]) => {
    set({ selectedTags: tags });
    get().applyFilters();
  },

  setArchiveFilter: (archive: string | null) => {
    set({ selectedArchive: archive });
    get().applyFilters();
  },

  setCollectionFilter: (collection: string | null) => {
    set({ selectedCollection: collection });
    get().applyFilters();
  },

  clearFilters: () => {
    set({
      searchQuery: '',
      selectedTags: [],
      selectedArchive: null,
      selectedCollection: null,
    });
    get().applyFilters();
  },

  applyFilters: () => {
    const { sources, searchQuery, selectedTags, selectedArchive, selectedCollection } = get();
    let filtered = [...sources];

    // Search query filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (s) =>
          s.title.toLowerCase().includes(query) ||
          s.creator?.toLowerCase().includes(query) ||
          s.archive?.toLowerCase().includes(query) ||
          s.collection?.toLowerCase().includes(query) ||
          s.transcription?.toLowerCase().includes(query)
      );
    }

    // Tags filter
    if (selectedTags.length > 0) {
      filtered = filtered.filter((s) =>
        selectedTags.every((tag) => s.tags.includes(tag))
      );
    }

    // Archive filter
    if (selectedArchive) {
      filtered = filtered.filter((s) => s.archive === selectedArchive);
    }

    // Collection filter
    if (selectedCollection) {
      filtered = filtered.filter((s) => s.collection === selectedCollection);
    }

    set({ filteredSources: filtered });
  },

  // MARK: - Statistics Actions

  refreshStatistics: async () => {
    const startedAt = generation;
    try {
      const result = await window.electron.tropy.getStatistics();
      if (startedAt !== generation) return;
      if (result.success && result.statistics) {
        set({ statistics: result.statistics });
      }
    } catch (error) {
      console.error('Failed to refresh statistics:', error);
    }
  },
}));

// Le projet Tropy lié, ses sources et les filtres appartiennent au projet ClioDeck : vidés à chaque
// changement de projet, panneau monté ou non (S18-1-30, A36). Le panneau le découvrait à son
// montage ; il n'a plus qu'à lire le projet entrant.
projectLifecycle.onReset('primarySources', () => usePrimarySourcesStore.getState().reset());
