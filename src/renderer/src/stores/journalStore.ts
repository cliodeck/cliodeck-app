import { create } from 'zustand';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface Session {
  id: string;
  projectPath: string;
  startedAt: Date;
  endedAt?: Date;
  totalDurationMs?: number;
  eventCount: number;
  metadata?: Record<string, any>;
}

export interface HistoryEvent {
  id: string;
  sessionId: string;
  eventType: string;
  timestamp: Date;
  eventData?: Record<string, any>;
}

export interface AIOperation {
  id: string;
  sessionId: string;
  operationType: 'rag_query' | 'summarization' | 'citation_extraction' | 'topic_modeling';
  timestamp: Date;
  durationMs?: number;
  inputText?: string;
  inputMetadata?: Record<string, any>;
  modelName?: string;
  modelParameters?: Record<string, any>;
  outputText?: string;
  outputMetadata?: Record<string, any>;
  success: boolean;
  errorMessage?: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: any[];
  timestamp: Date;
}

export interface HistoryStatistics {
  totalSessions: number;
  totalEvents: number;
  totalChatMessages: number;
  totalAIOperations: number;
  averageSessionDuration: number;
}

// ============================================================================
// Store Interface
// ============================================================================

interface JournalState {
  // Data
  sessions: Session[];
  selectedSession: Session | null;
  events: HistoryEvent[];
  aiOperations: AIOperation[];
  chatMessages: ChatMessage[];
  statistics: HistoryStatistics | null;

  // Project-wide data (all sessions aggregated)
  allEvents: HistoryEvent[];
  allAIOperations: AIOperation[];
  allChatMessages: ChatMessage[];

  // UI State
  loading: boolean;
  error: string | null;
  hideEmptySessions: boolean;
  viewScope: 'session' | 'project'; // 'session' = per-session view, 'project' = all sessions

  // Filters
  filters: {
    eventType?: string;
    startDate?: Date;
    endDate?: Date;
    searchQuery?: string;
  };

  // Actions
  loadSessions: () => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  loadEvents: (sessionId: string) => Promise<void>;
  loadAIOperations: (sessionId: string) => Promise<void>;
  loadChatHistory: (sessionId: string) => Promise<void>;
  loadStatistics: () => Promise<void>;
  exportReport: (sessionId: string, format: 'markdown' | 'json' | 'latex') => Promise<void>;
  setFilters: (filters: Partial<JournalState['filters']>) => void;
  searchEvents: () => Promise<void>;
  clearError: () => void;
  setHideEmptySessions: (hide: boolean) => void;
  setViewScope: (scope: 'session' | 'project') => void;
  loadAllProjectData: () => Promise<void>;
}

// ============================================================================
// Store Implementation
// ============================================================================

export const useJournalStore = create<JournalState>((set, get) => ({
  // Initial state
  sessions: [],
  selectedSession: null,
  events: [],
  aiOperations: [],
  chatMessages: [],
  statistics: null,
  allEvents: [],
  allAIOperations: [],
  allChatMessages: [],
  loading: false,
  error: null,
  hideEmptySessions: true,  // Hide empty sessions by default
  viewScope: 'session',
  filters: {},

  // Load all sessions
  loadSessions: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electron.history.getSessions();
      if (result.success) {
        // Parse dates
        const sessions = result.sessions.map((s: any) => ({
          ...s,
          startedAt: new Date(s.startedAt),
          endedAt: s.endedAt ? new Date(s.endedAt) : undefined,
        }));
        set({ sessions, loading: false });
      } else {
        set({ error: result.error, loading: false });
      }
    } catch (error: any) {
      set({ error: error.message, loading: false });
    }
  },

  // Select a session and load its data
  selectSession: async (sessionId: string) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    set({ selectedSession: session || null });

    if (session) {
      // Load all session data in parallel
      await Promise.all([
        get().loadEvents(sessionId),
        get().loadAIOperations(sessionId),
        get().loadChatHistory(sessionId),
      ]);
    }
  },

  // Load events for a session
  loadEvents: async (sessionId: string) => {
    set({ loading: true });
    try {
      const result = await window.electron.history.getEvents(sessionId);
      if (result.success) {
        // Parse dates
        const events = result.events.map((e: any) => ({
          ...e,
          timestamp: new Date(e.timestamp),
        }));
        set({ events, loading: false });
      } else {
        set({ error: result.error, loading: false });
      }
    } catch (error: any) {
      set({ error: error.message, loading: false });
    }
  },

  // Load AI operations for a session
  loadAIOperations: async (sessionId: string) => {
    try {
      const result = await window.electron.history.getAIOperations(sessionId);
      if (result.success) {
        // Parse dates
        const operations = result.operations.map((op: any) => ({
          ...op,
          timestamp: new Date(op.timestamp),
        }));
        set({ aiOperations: operations });
      }
    } catch (error: any) {
      console.error('Failed to load AI operations:', error);
    }
  },

  // Load chat history for a session
  loadChatHistory: async (sessionId: string) => {
    try {
      const result = await window.electron.history.getChatHistory(sessionId);
      if (result.success) {
        // Parse dates
        const messages = result.messages.map((msg: any) => ({
          ...msg,
          timestamp: new Date(msg.timestamp),
        }));
        set({ chatMessages: messages });
      }
    } catch (error: any) {
      console.error('Failed to load chat history:', error);
    }
  },

  // Load statistics
  loadStatistics: async () => {
    try {
      const result = await window.electron.history.getStatistics();
      if (result.success) {
        set({ statistics: result.statistics });
      }
    } catch (error: any) {
      console.error('Failed to load statistics:', error);
    }
  },

  // Export session report
  exportReport: async (sessionId: string, format: 'markdown' | 'json' | 'latex') => {
    set({ loading: true });
    try {
      const result = await window.electron.history.exportReport(sessionId, format);
      if (result.success) {
        // Create download
        const blob = new Blob([result.report], {
          type: format === 'json' ? 'application/json' : 'text/plain',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const extension = format === 'markdown' ? 'md' : format === 'json' ? 'json' : 'tex';
        a.download = `session-report-${sessionId.substring(0, 8)}.${extension}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        set({ loading: false });
      } else {
        set({ error: result.error, loading: false });
      }
    } catch (error: any) {
      set({ error: error.message, loading: false });
    }
  },

  // Set filters
  setFilters: (filters) => {
    set({ filters: { ...get().filters, ...filters } });
  },

  // Search events with filters
  searchEvents: async () => {
    set({ loading: true });
    try {
      const result = await window.electron.history.searchEvents(get().filters);
      if (result.success) {
        // Parse dates
        const events = result.events.map((e: any) => ({
          ...e,
          timestamp: new Date(e.timestamp),
        }));
        set({ events, loading: false });
      } else {
        set({ error: result.error, loading: false });
      }
    } catch (error: any) {
      set({ error: error.message, loading: false });
    }
  },

  // Clear error
  clearError: () => {
    set({ error: null });
  },

  // Toggle hide empty sessions
  setHideEmptySessions: (hide: boolean) => {
    set({ hideEmptySessions: hide });
  },

  // Set view scope (session or project)
  setViewScope: (scope: 'session' | 'project') => {
    set({ viewScope: scope });
    if (scope === 'project') {
      get().loadAllProjectData();
    }
  },

  // Load all project data (all sessions aggregated)
  loadAllProjectData: async () => {
    set({ loading: true });
    try {
      const [eventsResult, aiOpsResult, chatResult] = await Promise.all([
        window.electron.history.getAllEvents(),
        window.electron.history.getAllAIOperations(),
        window.electron.history.getAllChatMessages(),
      ]);

      const allEvents = eventsResult.success
        ? eventsResult.events.map((e: any) => ({
            ...e,
            timestamp: new Date(e.timestamp),
          }))
        : [];

      const allAIOperations = aiOpsResult.success
        ? aiOpsResult.operations.map((op: any) => ({
            ...op,
            timestamp: new Date(op.timestamp),
          }))
        : [];

      const allChatMessages = chatResult.success
        ? chatResult.messages.map((msg: any) => ({
            ...msg,
            timestamp: new Date(msg.timestamp),
          }))
        : [];

      set({
        allEvents,
        allAIOperations,
        allChatMessages,
        loading: false,
      });
    } catch (error: any) {
      set({ error: error.message, loading: false });
    }
  },
}));
