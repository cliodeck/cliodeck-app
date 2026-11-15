/**
 * Similarity Finder Store
 *
 * Manages state for the similarity finder feature,
 * including analysis results, progress, and options.
 */
import { create } from 'zustand';
import { logger } from '../utils/logger';
import { projectLifecycle } from '../lifecycle/projectLifecycle';

// MARK: - Types

export type Granularity = 'section' | 'paragraph' | 'sentence';
export type SourceType = 'secondary' | 'primary' | 'both';

export interface SimilarityOptions {
  granularity: Granularity;
  maxResults: number;
  similarityThreshold: number;
  collectionFilter: string[] | null;
  useReranking: boolean; // Use LLM to rerank results for better accuracy
  useContextualEmbedding: boolean; // Add document context to embeddings for better matching
  sourceType: SourceType; // Which sources to search: secondary (PDFs), primary (Tropy), or both
}

export interface TextSegment {
  id: string;
  content: string;
  startLine: number;
  endLine: number;
  type: Granularity;
  title?: string;
}

export interface PDFRecommendation {
  pdfId: string;
  title: string;
  authors: string[];
  similarity: number;
  chunkPreview: string;
  zoteroKey?: string;
  pageNumber?: number;
  // Source type indicator (for mixed results)
  sourceType?: 'secondary' | 'primary';
  // Primary source specific fields
  sourceId?: string;
  archive?: string;
  collection?: string;
  date?: string;
  tags?: string[];
}

export interface SimilarityResult {
  segmentId: string;
  segment: TextSegment;
  recommendations: PDFRecommendation[];
  analyzedAt: number;
}

export interface AnalysisProgress {
  current: number;
  total: number;
  status: string;
  percentage: number;
  currentSegment?: string;
}

// MARK: - Store Interface

interface SimilarityState {
  // Results
  results: Map<string, SimilarityResult>;
  selectedSegmentId: string | null;

  // Analysis state
  isAnalyzing: boolean;
  progress: AnalysisProgress;
  error: string | null;

  // Options
  options: SimilarityOptions;

  // Panel visibility
  isPanelOpen: boolean;

  // Actions
  /** Analyse `text`, le document ouvert dans `documentPath` (`null` sans nom). */
  analyze: (text: string, documentPath: string | null) => Promise<void>;
  cancelAnalysis: () => void;
  clearResults: () => void;
  selectSegment: (segmentId: string | null) => void;
  setOptions: (options: Partial<SimilarityOptions>) => void;
  togglePanel: () => void;
  openPanel: () => void;
  closePanel: () => void;
  /**
   * Les résultats en cache pour le document ouvert, `text` dans `documentPath` (`null` sans nom) :
   * ils remplacent toujours la liste.
   */
  loadCachedResults: (text: string, documentPath: string | null) => Promise<void>;

  // Internal
  setProgress: (progress: AnalysisProgress) => void;
  setError: (error: string | null) => void;
}

// MARK: - Default Values

const DEFAULT_OPTIONS: SimilarityOptions = {
  granularity: 'paragraph',
  maxResults: 5,
  // Threshold set to 0 to rely on pdfService's built-in filtering
  // which already handles cross-language search with appropriate fallbacks
  similarityThreshold: 0,
  collectionFilter: null,
  useReranking: true, // Enable LLM reranking by default for better accuracy
  useContextualEmbedding: true, // Add document context to embeddings by default
  sourceType: 'secondary', // Default to secondary sources (PDFs) only
};

const DEFAULT_PROGRESS: AnalysisProgress = {
  current: 0,
  total: 0,
  status: '',
  percentage: 0,
};

/** Les analyses lancées : seule la dernière met fin à l'attente quand son projet a quitté l'écran. */
let analyses = 0;

/**
 * Les relectures du cache, une par document affiché (S13-1-3) : seule la dernière s'inscrit, et une
 * analyse partie avant elle n'affiche ses résultats tels quels que si ce document est le sien. Les
 * résultats affichés d'une analyse comptent comme la dernière relecture.
 */
let views = 0;
/** Le document de la dernière relecture : celui qui est ouvert. */
let viewed: { text: string; documentPath: string | null } = { text: '', documentPath: null };

/**
 * Le document affiché est-il celui de l'analyse ? La règle du main (`getAllCachedResults`) : le
 * texte exact, quel que soit le fichier (« Enregistrer sous »), ou le même fichier. Les deux chemins
 * sont le `filePath` de l'éditeur, lu à deux moments : s'ils diffèrent pour un même fichier (casse),
 * la relecture du main, qui compare par `sameFile`, tranche.
 */
const isViewed = (text: string, documentPath: string | null): boolean =>
  viewed.text === text || (documentPath !== null && viewed.documentPath === documentPath);

const DONE_PROGRESS: AnalysisProgress = {
  ...DEFAULT_PROGRESS,
  percentage: 100,
  status: 'Analyse terminée',
};

// MARK: - Store

export const useSimilarityStore = create<SimilarityState>((set, get) => ({
  // Initial state
  results: new Map(),
  selectedSegmentId: null,
  isAnalyzing: false,
  progress: DEFAULT_PROGRESS,
  error: null,
  options: DEFAULT_OPTIONS,
  isPanelOpen: false,

  // Actions
  analyze: async (text: string, documentPath: string | null) => {
    logger.store('Similarity', 'Starting analysis', { textLength: text.length });
    const { options } = get();
    // L'analyse vaut pour le projet où elle est partie : ni sa progression, ni ses résultats, ni son
    // échec ne s'affichent dans un autre (S18-1-25). Si elle est la dernière partie, elle met
    // seulement fin à l'attente, pour le projet d'avant revenu après un échec.
    const analysis = ++analyses;
    const handle = projectLifecycle.capture();
    const view = views;
    const stale = (): boolean => {
      if (handle?.isCurrent()) return false;
      if (analysis === analyses) set({ isAnalyzing: false, progress: DEFAULT_PROGRESS });
      return true;
    };

    set({
      isAnalyzing: true,
      error: null,
      progress: { ...DEFAULT_PROGRESS, status: 'Démarrage de l\'analyse...' },
    });

    try {
      // Setup progress listener
      const removeListener = window.electron.similarity.onProgress((progress) => {
        if (!handle?.isCurrent()) return;
        logger.store('Similarity', 'Progress update', progress);
        set({ progress });
      });

      // Call IPC
      logger.ipc('similarity.analyze', { textLength: text.length, options });
      const result = await window.electron.similarity.analyze(text, options, documentPath);
      logger.ipc('similarity.analyze response', { success: result.success });

      // Remove listener
      removeListener();
      if (stale()) return;

      if (result.success && result.results) {
        // Un autre document s'est ouvert pendant l'analyse : ses résultats sont ceux du texte
        // analysé. Le cache, qu'elle vient d'écrire, est relu pour le document ouvert. Le même
        // document relu entre-temps (panneau refermé et rouvert, aller et retour d'un chapitre à
        // l'autre) affiche ses résultats, comme sans relecture : relire le cache ne rendait rien
        // quand le corpus avait changé pendant l'analyse ou que le cache n'avait pas pu s'écrire,
        // et des minutes de reclassement étaient perdues (revue de L11-2).
        if (view !== views && !isViewed(text, documentPath)) {
          set({ isAnalyzing: false, progress: DONE_PROGRESS });
          void get().loadCachedResults(viewed.text, viewed.documentPath);
          return;
        }
        // Une relecture encore en vol a lu le cache d'avant l'analyse : elle ne s'inscrit plus.
        views += 1;

        // Convert array to Map
        const resultsMap = new Map<string, SimilarityResult>();
        for (const r of result.results) {
          resultsMap.set(r.segmentId, r);
        }

        set({
          results: resultsMap,
          isAnalyzing: false,
          progress: DONE_PROGRESS,
        });

        logger.store('Similarity', 'Analysis complete', {
          segments: resultsMap.size,
          totalRecommendations: result.results.reduce(
            (sum: number, r: SimilarityResult) => sum + r.recommendations.length,
            0
          ),
        });
      } else {
        throw new Error(result.error || 'Unknown error during analysis');
      }
    } catch (error) {
      logger.error('Similarity', error);
      if (stale()) return;
      set({
        isAnalyzing: false,
        error:
          error instanceof Error ? error.message : 'Erreur lors de l\'analyse',
        progress: DEFAULT_PROGRESS,
      });
    }
  },

  cancelAnalysis: async () => {
    logger.store('Similarity', 'Cancelling analysis');
    try {
      await window.electron.similarity.cancel();
      set({
        isAnalyzing: false,
        progress: DEFAULT_PROGRESS,
      });
    } catch (error) {
      logger.error('Similarity', 'Cancel failed', error);
    }
  },

  clearResults: async () => {
    logger.store('Similarity', 'Clearing results');
    try {
      await window.electron.similarity.clearCache();
      set({
        results: new Map(),
        selectedSegmentId: null,
        progress: DEFAULT_PROGRESS,
        error: null,
      });
    } catch (error) {
      logger.error('Similarity', 'Clear cache failed', error);
    }
  },

  selectSegment: (segmentId: string | null) => {
    logger.store('Similarity', 'Selecting segment', { segmentId });
    set({ selectedSegmentId: segmentId });

    // Auto-open panel when selecting a segment
    if (segmentId) {
      set({ isPanelOpen: true });
    }
  },

  setOptions: (newOptions: Partial<SimilarityOptions>) => {
    logger.store('Similarity', 'Updating options', newOptions);
    set((state) => ({
      options: { ...state.options, ...newOptions },
    }));
  },

  togglePanel: () => {
    set((state) => ({ isPanelOpen: !state.isPanelOpen }));
  },

  openPanel: () => {
    set({ isPanelOpen: true });
  },

  closePanel: () => {
    set({ isPanelOpen: false, selectedSegmentId: null });
  },

  loadCachedResults: async (text: string, documentPath: string | null) => {
    logger.store('Similarity', 'Loading cached results');
    const handle = projectLifecycle.capture();
    const view = ++views;
    viewed = { text, documentPath };
    const resultsMap = new Map<string, SimilarityResult>();
    try {
      const result = await window.electron.similarity.getAllResults(text, documentPath);
      if (result.success && result.results) {
        for (const r of result.results) {
          resultsMap.set(r.segmentId, r);
        }
      }
    } catch (error) {
      logger.error('Similarity', 'Failed to load cached results', error);
    }
    // Le cache d'un projet qui n'est plus à l'écran : ses segments et ses clés n'ont rien à faire ici.
    // Une relecture partie avant la dernière est celle d'un autre document.
    if (!handle?.isCurrent() || view !== views) return;
    // Toujours remplacée, même vide ou en échec : la liste d'un autre document ne reste pas.
    set({ results: resultsMap });
    logger.store('Similarity', 'Cached results loaded', { segments: resultsMap.size });
  },

  // Internal
  setProgress: (progress: AnalysisProgress) => {
    set({ progress });
  },

  setError: (error: string | null) => {
    set({ error });
  },
}));

// Le filtre de collections désigne des clés Zotero du projet, et les résultats ses segments et ses
// références : dans un autre projet, le filtre ne laissait passer aucune recommandation, sans être
// visible, et « Insérer la citation » y mettait les clés du précédent (S18-1-25). Une analyse en vol
// appartient au projet quitté : elle s'arrête. Les autres options ne dépendent pas du projet.
projectLifecycle.onReset('similarity', () => {
  if (useSimilarityStore.getState().isAnalyzing) {
    void Promise.resolve()
      .then(() => window.electron.similarity.cancel())
      .catch((error: unknown) => logger.error('Similarity', 'Cancel on project change failed', error));
  }
  useSimilarityStore.setState((state) => ({
    results: new Map(),
    selectedSegmentId: null,
    isAnalyzing: false,
    progress: DEFAULT_PROGRESS,
    error: null,
    options: { ...state.options, collectionFilter: null },
  }));
});

// MARK: - Selectors

/**
 * Get the currently selected segment's results
 */
export const useSelectedSegmentResults = () => {
  const { results, selectedSegmentId } = useSimilarityStore();
  if (!selectedSegmentId) return null;
  return results.get(selectedSegmentId) || null;
};

/**
 * Get all segments as an array (sorted by startLine)
 */
export const useAllSegments = () => {
  const { results } = useSimilarityStore();
  return Array.from(results.values())
    .sort((a, b) => a.segment.startLine - b.segment.startLine);
};

/**
 * Check if there are any results
 */
export const useHasResults = () => {
  const { results } = useSimilarityStore();
  return results.size > 0;
};

/**
 * Get total recommendation count
 */
export const useTotalRecommendations = () => {
  const { results } = useSimilarityStore();
  let total = 0;
  results.forEach((r) => {
    total += r.recommendations.length;
  });
  return total;
};
