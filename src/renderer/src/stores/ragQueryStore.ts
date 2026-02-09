import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// MARK: - Types

export type LLMProvider = 'ollama' | 'embedded' | 'auto';
export type SourceType = 'secondary' | 'primary' | 'both';

export interface RAGQueryParams {
  // Provider selection
  provider: LLMProvider;

  // Core parameters
  model: string; // Ollama model name (used when provider is 'ollama' or 'auto')
  topK: number;
  timeout: number; // in milliseconds

  // Context window size (num_ctx for Ollama)
  numCtx: number; // Context window in tokens (0 = use model default)

  // Source type selection (primary = Tropy, secondary = bibliography/PDFs)
  sourceType: SourceType;

  // Collection filtering (Zotero collections)
  selectedCollectionKeys: string[]; // Empty = all collections (no filter)

  // Document filtering (Issue #16: filter by specific documents)
  selectedDocumentIds: string[]; // Empty = all documents (no filter)

  // Advanced parameters
  temperature: number;
  top_p: number;
  top_k: number;
  repeat_penalty: number;

  // System prompt configuration (Phase 2.3)
  systemPromptLanguage: 'fr' | 'en';
  customSystemPrompt?: string;
  useCustomSystemPrompt: boolean;
}

export interface AvailableModel {
  id: string;
  name: string;
  size: string;
  description?: string;
}

export interface AvailableCollection {
  key: string;
  name: string;
  parentKey?: string;
  level?: number; // For hierarchical display indentation
}

// Issue #16: Available document for filtering
export interface AvailableDocument {
  id: string;
  title: string;
  author?: string;
  year?: string;
}

interface RAGQueryState {
  // Query parameters (persisted)
  params: RAGQueryParams;

  // Available models (not persisted, loaded from Ollama)
  availableModels: AvailableModel[];
  isLoadingModels: boolean;

  // Available collections (not persisted, loaded from VectorStore)
  availableCollections: AvailableCollection[];
  isLoadingCollections: boolean;

  // Issue #16: Available documents (not persisted, loaded from VectorStore)
  availableDocuments: AvailableDocument[];
  isLoadingDocuments: boolean;

  // UI state (not persisted)
  isSettingsPanelOpen: boolean;

  // Actions
  setParams: (params: Partial<RAGQueryParams>) => void;
  resetToDefaults: () => Promise<void>;
  loadAvailableModels: () => Promise<void>;
  loadAvailableCollections: () => Promise<void>;
  setSelectedCollections: (keys: string[]) => void;
  loadAvailableDocuments: () => Promise<void>; // Issue #16
  setSelectedDocuments: (ids: string[]) => void; // Issue #16
  toggleSettingsPanel: () => void;
}

// Default values - will be loaded from global config on first run
const DEFAULT_PARAMS: RAGQueryParams = {
  provider: 'auto',
  model: 'gemma2:2b',
  topK: 10,
  timeout: 600000, // 10 minutes

  // Context window (0 = use model's default, which is often 2048 in Ollama)
  numCtx: 4096,

  // Source type (default: search both primary and secondary sources)
  sourceType: 'both',

  // Collection filtering (empty = no filter, search all)
  selectedCollectionKeys: [],

  // Document filtering (Issue #16: empty = no filter, search all)
  selectedDocumentIds: [],

  // Academic preset (from OllamaClient)
  temperature: 0.1,
  top_p: 0.85,
  top_k: 40,
  repeat_penalty: 1.1,

  // System prompt (default: French)
  systemPromptLanguage: 'fr',
  useCustomSystemPrompt: false,
};

/**
 * Sort collections hierarchically (parents first, then children indented)
 */
function sortCollectionsHierarchically(
  collections: Array<{ key: string; name: string; parentKey?: string }>
): AvailableCollection[] {
  const result: AvailableCollection[] = [];

  const addWithChildren = (
    parent: { key: string; name: string; parentKey?: string },
    level: number = 0
  ) => {
    result.push({ ...parent, level });
    const children = collections.filter((c) => c.parentKey === parent.key);
    children.forEach((child) => addWithChildren(child, level + 1));
  };

  // Start with top-level collections (no parent)
  const topLevel = collections.filter((c) => !c.parentKey);
  topLevel.forEach((col) => addWithChildren(col));

  return result;
}

// MARK: - Store

export const useRAGQueryStore = create<RAGQueryState>()(
  persist(
    (set, _get) => ({
      // Initial state
      params: DEFAULT_PARAMS,
      availableModels: [],
      isLoadingModels: false,
      availableCollections: [],
      isLoadingCollections: false,
      availableDocuments: [], // Issue #16
      isLoadingDocuments: false, // Issue #16
      isSettingsPanelOpen: false,

      // Actions
      setParams: (newParams: Partial<RAGQueryParams>) => {
        set((state) => ({
          params: { ...state.params, ...newParams },
        }));
      },

      resetToDefaults: async () => {
        try {
          // Load defaults from global config
          const config = await window.electron.config.getAll();
          const llmConfig = config.llm;
          const ragConfig = config.rag;

          set({
            params: {
              provider: (llmConfig.generationProvider as LLMProvider) || DEFAULT_PARAMS.provider,
              model: llmConfig.ollamaChatModel || DEFAULT_PARAMS.model,
              topK: ragConfig.topK || DEFAULT_PARAMS.topK,
              timeout: DEFAULT_PARAMS.timeout,
              numCtx: ragConfig.numCtx || DEFAULT_PARAMS.numCtx,
              sourceType: DEFAULT_PARAMS.sourceType,
              selectedCollectionKeys: DEFAULT_PARAMS.selectedCollectionKeys,
              selectedDocumentIds: DEFAULT_PARAMS.selectedDocumentIds, // Issue #16
              temperature: DEFAULT_PARAMS.temperature,
              top_p: DEFAULT_PARAMS.top_p,
              top_k: DEFAULT_PARAMS.top_k,
              repeat_penalty: DEFAULT_PARAMS.repeat_penalty,
              systemPromptLanguage: ragConfig.systemPromptLanguage || DEFAULT_PARAMS.systemPromptLanguage,
              customSystemPrompt: ragConfig.customSystemPrompt,
              useCustomSystemPrompt: ragConfig.useCustomSystemPrompt || DEFAULT_PARAMS.useCustomSystemPrompt,
            },
          });

          console.log('✅ RAG query params reset to config defaults');
        } catch (error) {
          // Silently fallback to hardcoded defaults (config might not be ready yet)
          set({ params: DEFAULT_PARAMS });
        }
      },

      loadAvailableModels: async () => {
        set({ isLoadingModels: true });

        try {
          console.log('🔄 Loading available Ollama models...');
          const result = await window.electron.ollama.listModels();

          console.log('📦 Ollama API response:', result);

          if (result.success && result.models) {
            console.log(`📋 All models from Ollama (${result.models.length}):`, result.models.map(m => m.id));

            // Filter only chat models (exclude embedding models)
            const chatModels = result.models.filter(
              (model: AvailableModel) =>
                !model.id.includes('embed') && !model.id.includes('embedding')
            );

            console.log(`✅ Chat models after filtering (${chatModels.length}):`, chatModels.map(m => m.id));

            set({
              availableModels: chatModels,
              isLoadingModels: false,
            });

            console.log(`✅ Loaded ${chatModels.length} chat models from Ollama`);
          } else {
            throw new Error(result.error || 'Failed to load models');
          }
        } catch (error) {
          // Silently handle error - models will be loaded when a project is opened
          console.warn('⚠️  Could not load Ollama models:', error);
          set({
            availableModels: [],
            isLoadingModels: false,
          });
        }
      },

      loadAvailableCollections: async () => {
        set({ isLoadingCollections: true });

        try {
          console.log('🔄 Loading available Zotero collections...');
          const result = await window.electron.corpus.getCollections();

          if (result.success && result.collections) {
            // Sort hierarchically for display
            const sortedCollections = sortCollectionsHierarchically(result.collections);

            set({
              availableCollections: sortedCollections,
              isLoadingCollections: false,
            });

            console.log(`✅ Loaded ${sortedCollections.length} collections`);
          } else {
            console.warn('⚠️  No collections found:', result.error);
            set({
              availableCollections: [],
              isLoadingCollections: false,
            });
          }
        } catch (error) {
          console.warn('⚠️  Could not load collections:', error);
          set({
            availableCollections: [],
            isLoadingCollections: false,
          });
        }
      },

      setSelectedCollections: (keys: string[]) => {
        set((state) => ({
          params: { ...state.params, selectedCollectionKeys: keys },
        }));
      },

      // Issue #16: Load available documents from VectorStore
      loadAvailableDocuments: async () => {
        set({ isLoadingDocuments: true });

        try {
          console.log('🔄 Loading available documents...');
          const result = await window.electron.pdf.getAll();

          if (result.success && result.documents) {
            // Map to AvailableDocument format
            const documents: AvailableDocument[] = result.documents.map((doc: any) => ({
              id: doc.id,
              title: doc.title || 'Untitled',
              author: doc.author,
              year: doc.year,
            }));

            // Sort by author, then title
            documents.sort((a, b) => {
              const authorA = a.author || '';
              const authorB = b.author || '';
              if (authorA !== authorB) return authorA.localeCompare(authorB);
              return a.title.localeCompare(b.title);
            });

            set({
              availableDocuments: documents,
              isLoadingDocuments: false,
            });

            console.log(`✅ Loaded ${documents.length} documents`);
          } else {
            console.warn('⚠️  No documents found:', result.error);
            set({
              availableDocuments: [],
              isLoadingDocuments: false,
            });
          }
        } catch (error) {
          console.warn('⚠️  Could not load documents:', error);
          set({
            availableDocuments: [],
            isLoadingDocuments: false,
          });
        }
      },

      // Issue #16: Set selected documents for filtering
      setSelectedDocuments: (ids: string[]) => {
        set((state) => ({
          params: { ...state.params, selectedDocumentIds: ids },
        }));
      },

      toggleSettingsPanel: () => {
        set((state) => ({
          isSettingsPanelOpen: !state.isSettingsPanelOpen,
        }));
      },
    }),
    {
      name: 'rag-query-params', // localStorage key
      // Only persist params, not UI state or available models
      partialize: (state) => ({ params: state.params }),
    }
  )
);

// Initialize from config on first load
if (typeof window !== 'undefined') {
  // Load defaults from config on startup
  useRAGQueryStore.getState().resetToDefaults();

  // Don't load models immediately - they'll be loaded when panel opens
  // (Ollama client needs a project to be loaded first)
}
