/**
 * Similarity Finder Store
 *
 * Manages state for the similarity finder feature,
 * including analysis results, progress, and options.
 */
import { create } from 'zustand';
import { logger } from '../utils/logger';

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
  analyze: (text: string) => Promise<void>;
  cancelAnalysis: () => void;
  clearResults: () => void;
  selectSegment: (segmentId: string | null) => void;
  setOptions: (options: Partial<SimilarityOptions>) => void;
  togglePanel: () => void;
  openPanel: () => void;
  closePanel: () => void;
  loadCachedResults: () => Promise<void>;

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
  analyze: async (text: string) => {
    logger.store('Similarity', 'Starting analysis', { textLength: text.length });
    const { options } = get();

    set({
      isAnalyzing: true,
      error: null,
      progress: { ...DEFAULT_PROGRESS, status: 'Démarrage de l\'analyse...' },
    });

    try {
      // Setup progress listener
      const removeListener = window.electron.similarity.onProgress((progress) => {
        logger.store('Similarity', 'Progress update', progress);
        set({ progress });
      });

      // Call IPC
      logger.ipc('similarity.analyze', { textLength: text.length, options });
      const result = await window.electron.similarity.analyze(text, options);
      logger.ipc('similarity.analyze response', { success: result.success });

      // Remove listener
      removeListener();

      if (result.success && result.results) {
        // Convert array to Map
        const resultsMap = new Map<string, SimilarityResult>();
        for (const r of result.results) {
          resultsMap.set(r.segmentId, r);
        }

        set({
          results: resultsMap,
          isAnalyzing: false,
          progress: {
            ...DEFAULT_PROGRESS,
            percentage: 100,
            status: 'Analyse terminée',
          },
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
    } catch (error: any) {
      logger.error('Similarity', error);
      set({
        isAnalyzing: false,
        error: error.message || 'Erreur lors de l\'analyse',
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
    } catch (error: any) {
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
    } catch (error: any) {
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

  loadCachedResults: async () => {
    logger.store('Similarity', 'Loading cached results');
    try {
      const result = await window.electron.similarity.getAllResults();

      if (result.success && result.results) {
        const resultsMap = new Map<string, SimilarityResult>();
        for (const r of result.results) {
          resultsMap.set(r.segmentId, r);
        }

        set({ results: resultsMap });
        logger.store('Similarity', 'Cached results loaded', { segments: resultsMap.size });
      }
    } catch (error: any) {
      logger.error('Similarity', 'Failed to load cached results', error);
    }
  },

  // Internal
  setProgress: (progress: AnalysisProgress) => {
    set({ progress });
  },

  setError: (error: string | null) => {
    set({ error });
  },
}));

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
