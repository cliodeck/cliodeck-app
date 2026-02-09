import { create } from 'zustand';

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
  transcriptionSource?: 'tesseract' | 'transkribus' | 'manual' | 'tropy-notes';
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

  // Search & filters
  searchQuery: string;
  selectedTags: string[];
  selectedArchive: string | null;
  selectedCollection: string | null;

  // Statistics
  statistics: PrimarySourcesStatistics | null;

  // OCR Languages
  availableOCRLanguages: Array<{ code: string; name: string }>;

  // Actions - Project
  openTPYProject: (tpyPath: string) => Promise<{ success: boolean; error?: string }>;
  getProjectInfo: () => Promise<void>;

  // Actions - Sync
  syncTPY: (options: {
    performOCR: boolean;
    ocrLanguage: string;
    transcriptionDirectory?: string;
    forceReindex?: boolean;
  }) => Promise<{ success: boolean; newItems?: number; errors?: string[] }>;
  checkSyncNeeded: () => Promise<boolean>;

  // Actions - Watching
  startWatching: () => Promise<void>;
  stopWatching: () => Promise<void>;

  // Actions - OCR
  performOCR: (sourceId: string, imagePaths: string[], language: string) => Promise<{ success: boolean; text?: string }>;
  importTranscription: (sourceId: string, filePath: string) => Promise<{ success: boolean; error?: string }>;
  loadOCRLanguages: () => Promise<void>;

  // Actions - Sources
  refreshSources: () => Promise<void>;
  selectSource: (sourceId: string | null) => void;
  getSource: (sourceId: string) => Promise<PrimarySource | null>;
  updateTranscription: (sourceId: string, transcription: string, source: 'manual') => Promise<void>;

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

export const usePrimarySourcesStore = create<PrimarySourcesState>((set, get) => ({
  // Initial state
  sources: [],
  filteredSources: [],
  selectedSourceId: null,
  tpyPath: null,
  projectInfo: null,
  isSyncing: false,
  syncProgress: null,
  isPerformingOCR: false,
  ocrProgress: null,
  searchQuery: '',
  selectedTags: [],
  selectedArchive: null,
  selectedCollection: null,
  statistics: null,
  availableOCRLanguages: [],

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

      return { success: false, error: result.error };
    } catch (error: any) {
      console.error('Failed to open TPY project:', error);
      return { success: false, error: error.message };
    }
  },

  getProjectInfo: async () => {
    try {
      const result = await window.electron.tropy.getProjectInfo();
      if (result.success && result.info) {
        // Restaurer aussi le tpyPath depuis les infos du projet
        set({
          projectInfo: result.info,
          tpyPath: result.info.tpyPath || null,
        });
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

    // Setup progress listener
    const unsubscribe = window.electron.tropy.onSyncProgress((progress) => {
      set({ syncProgress: progress });
    });

    try {
      const result = await window.electron.tropy.sync(options);

      if (result.success) {
        // Refresh sources after sync
        await get().refreshSources();
        await get().refreshStatistics();
        await get().getProjectInfo();

        return {
          success: true,
          newItems: result.newItems,
          errors: result.errors,
        };
      }

      return { success: false, errors: result.errors };
    } catch (error: any) {
      console.error('Sync failed:', error);
      return { success: false, errors: [error.message] };
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
    const { tpyPath } = get();
    if (!tpyPath) return;

    try {
      await window.electron.tropy.startWatching(tpyPath);
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
        // Update the source with the transcription
        await get().updateTranscription(sourceId, result.text, 'manual');

        return { success: true, text: result.text };
      }

      return { success: false };
    } catch (error: any) {
      console.error('OCR failed:', error);
      return { success: false };
    } finally {
      set({ isPerformingOCR: false, ocrProgress: null });
    }
  },

  importTranscription: async (sourceId: string, filePath: string) => {
    try {
      const result = await window.electron.tropy.importTranscription(filePath);

      if (result.success && result.text) {
        await window.electron.tropy.updateTranscription(sourceId, result.text, 'transkribus');
        await get().refreshSources();

        return { success: true };
      }

      return { success: false, error: result.error };
    } catch (error: any) {
      console.error('Import transcription failed:', error);
      return { success: false, error: error.message };
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
    try {
      const result = await window.electron.tropy.getAllSources();

      if (result.success && result.sources) {
        const sources: PrimarySource[] = result.sources.map((s: any) => ({
          id: s.id,
          tropyId: s.tropyId,
          title: s.title,
          date: s.date,
          creator: s.creator,
          archive: s.archive,
          collection: s.collection,
          type: s.type,
          tags: [],
          transcription: s.transcription,
          transcriptionSource: s.transcriptionSource,
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

  updateTranscription: async (sourceId: string, transcription: string, source: 'manual') => {
    try {
      await window.electron.tropy.updateTranscription(sourceId, transcription, source);
      await get().refreshSources();
    } catch (error) {
      console.error('Failed to update transcription:', error);
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
    try {
      const result = await window.electron.tropy.getStatistics();
      if (result.success && result.statistics) {
        set({ statistics: result.statistics });
      }
    } catch (error) {
      console.error('Failed to refresh statistics:', error);
    }
  },
}));
