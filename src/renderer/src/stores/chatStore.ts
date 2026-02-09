import { create } from 'zustand';
import { logger } from '../utils/logger';

// MARK: - Types

// Type pour l'explication du RAG (Explainable AI)
export interface RAGExplanation {
  search: {
    query: string;
    totalResults: number;
    searchDurationMs: number;
    cacheHit: boolean;
    sourceType: 'primary' | 'secondary' | 'both';
    documents: Array<{
      title: string;
      similarity: number;
      sourceType: string;
      chunkCount: number;
    }>;
  };
  compression?: {
    enabled: boolean;
    originalChunks: number;
    finalChunks: number;
    originalSize: number;
    finalSize: number;
    reductionPercent: number;
    strategy?: string;
  };
  graph?: {
    enabled: boolean;
    relatedDocsFound: number;
    documentTitles: string[];
  };
  llm: {
    provider: string;
    model: string;
    contextWindow: number;
    temperature: number;
    promptSize: number;
  };
  timing: {
    searchMs: number;
    compressionMs?: number;
    generationMs: number;
    totalMs: number;
  };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: ChatSource[];
  timestamp: Date;
  ragUsed?: boolean; // true if RAG context was used for this response
  isError?: boolean; // true if this message is an error response
  explanation?: RAGExplanation; // RAG explanation for Explainable AI
  modeId?: string; // Mode active when this message was sent/received
}

export interface ChatSource {
  documentId: string;
  documentTitle: string;
  author?: string;
  year?: string;
  pageNumber: number;
  chunkContent: string;
  similarity: number;
}

interface ChatState {
  // Messages
  messages: ChatMessage[];
  isProcessing: boolean;
  currentStreamingMessage: string;

  // Filters
  selectedDocumentIds: string[];

  // Actions
  sendMessage: (query: string) => Promise<void>;
  cancelGeneration: () => void;
  clearChat: () => void;

  setSelectedDocuments: (documentIds: string[]) => void;

  // Internal
  addUserMessage: (content: string) => void;
  addAssistantMessage: (content: string, sources?: ChatSource[], ragUsed?: boolean, isError?: boolean, explanation?: RAGExplanation) => void;
}

// MARK: - Store

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isProcessing: false,
  currentStreamingMessage: '',
  selectedDocumentIds: [],

  addUserMessage: (content: string) => {
    // Import modeStore lazily to get active mode ID
    let modeId: string | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { useModeStore } = require('./modeStore');
      modeId = useModeStore.getState().activeModeId;
    } catch { /* modeStore not yet available */ }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: new Date(),
      modeId,
    };

    set((state) => ({
      messages: [...state.messages, userMessage],
    }));
  },

  addAssistantMessage: (content: string, sources?: ChatSource[], ragUsed?: boolean, isError?: boolean, explanation?: RAGExplanation) => {
    let modeId: string | undefined;
    try {
      const { useModeStore } = require('./modeStore');
      modeId = useModeStore.getState().activeModeId;
    } catch { /* modeStore not yet available */ }

    const assistantMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content,
      sources,
      timestamp: new Date(),
      ragUsed,
      isError,
      explanation,
      modeId,
    };

    set((state) => ({
      messages: [...state.messages, assistantMessage],
      isProcessing: false,
      currentStreamingMessage: '',
    }));
  },

  sendMessage: async (query: string) => {
    logger.store('Chat', 'sendMessage called', { query });
    const { addUserMessage, addAssistantMessage } = get();

    // Add user message
    logger.store('Chat', 'Adding user message');
    addUserMessage(query);

    // Set processing
    set({ isProcessing: true });

    try {
      // Get RAG query parameters from store
      const { useRAGQueryStore } = await import('./ragQueryStore');
      const ragParams = useRAGQueryStore.getState().params;

      // Setup stream listener
      let streamedContent = '';
      logger.store('Chat', 'Setting up stream listener');
      window.electron.chat.onStream((chunk: string) => {
        logger.store('Chat', 'Received stream chunk', { chunkLength: chunk.length });
        streamedContent += chunk;
        set({ currentStreamingMessage: streamedContent });
      });

      // Get active mode for system prompt override
      const { useModeStore } = await import('./modeStore');
      const activeMode = useModeStore.getState().activeMode;
      const activeModeId = useModeStore.getState().activeModeId;

      // Call IPC to send chat message with context enabled and RAG parameters
      // Map selectedCollectionKeys and selectedDocumentIds to IPC format
      const { selectedCollectionKeys, selectedDocumentIds, ...otherRagParams } = ragParams;
      const ipcOptions: Record<string, any> = {
        context: true,
        ...otherRagParams,
        collectionKeys: selectedCollectionKeys?.length > 0 ? selectedCollectionKeys : undefined,
        documentIds: selectedDocumentIds?.length > 0 ? selectedDocumentIds : undefined, // Issue #16
        modeId: activeModeId,
      };

      // Apply mode system prompt overrides
      if (activeMode && activeModeId === 'free-mode') {
        // Free mode: no system prompt at all
        ipcOptions.noSystemPrompt = true;
      } else if (activeMode && activeModeId !== 'default-assistant') {
        // Non-default mode: inject mode's system prompt
        const lang = ragParams.systemPromptLanguage || 'fr';
        const modePrompt = activeMode.systemPrompt[lang];
        if (modePrompt) {
          ipcOptions.useCustomSystemPrompt = true;
          ipcOptions.customSystemPrompt = modePrompt;
        }
      }
      // default-assistant: uses the existing SystemPrompts.ts defaults (no override needed)

      // Apply mode RAG overrides that aren't in ragQueryStore params
      if (activeMode) {
        const rag = activeMode.ragOverrides;
        if (rag.useGraphContext !== undefined) ipcOptions.useGraphContext = rag.useGraphContext;
        if (rag.enableContextCompression !== undefined) ipcOptions.enableContextCompression = rag.enableContextCompression;
      }

      logger.ipc('chat.send', { query, ipcOptions });
      const result = await window.electron.chat.send(query, ipcOptions);
      logger.ipc('chat.send response', result);

      // Add assistant message with the response
      if (result.success && result.response) {
        logger.store('Chat', 'Adding assistant response', {
          responseLength: result.response.length,
          ragUsed: result.ragUsed,
        });
        addAssistantMessage(result.response, undefined, result.ragUsed, false, result.explanation);
      } else {
        logger.error('Chat', 'No response or error: ' + (result.error || 'Réponse vide'));
        addAssistantMessage(`Erreur: ${result.error || 'Réponse vide'}`, undefined, undefined, true, undefined);
      }
    } catch (error: any) {
      logger.error('Chat', error);
      addAssistantMessage(`Erreur: ${error.message || error}`, undefined, undefined, true);
    } finally {
      set({ isProcessing: false, currentStreamingMessage: '' });
    }
  },

  cancelGeneration: async () => {
    try {
      await window.electron.chat.cancel();
      set({
        isProcessing: false,
        currentStreamingMessage: '',
      });
    } catch (error) {
      console.error('Failed to cancel generation:', error);
    }
  },

  clearChat: () => {
    set({
      messages: [],
      isProcessing: false,
      currentStreamingMessage: '',
    });
  },

  setSelectedDocuments: (documentIds: string[]) => {
    set({ selectedDocumentIds: documentIds });
  },
}));
