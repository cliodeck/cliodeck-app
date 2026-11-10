import { create, type StoreApi } from 'zustand';
import { projectLifecycle } from '../lifecycle/projectLifecycle';

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
  metadata?: Record<string, unknown>;
}

export interface HistoryEvent {
  id: string;
  sessionId: string;
  eventType: string;
  timestamp: Date;
  eventData?: Record<string, unknown>;
}

export interface AIOperation {
  id: string;
  sessionId: string;
  operationType: 'rag_query' | 'summarization' | 'citation_extraction' | 'topic_modeling';
  timestamp: Date;
  durationMs?: number;
  inputText?: string;
  inputMetadata?: Record<string, unknown>;
  modelName?: string;
  modelParameters?: Record<string, unknown>;
  outputText?: string;
  outputMetadata?: Record<string, unknown>;
  success: boolean;
  errorMessage?: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  /** Raisonnement d'un modèle pensant, à part de la réponse. */
  thinking?: string;
  sources?: unknown[];
  timestamp: Date;
}

// ============================================================================
// Raw IPC shapes — mirror the in-store types but with dates as strings.
// The preload's history.* methods return `Promise<unknown>` (no schema
// passthrough yet), so we narrow at the mapper level. Keeping these as
// dedicated types instead of `any` makes a future schema-bump grep-able.
// ============================================================================

type RawSession = Omit<Session, 'startedAt' | 'endedAt'> & {
  startedAt: string;
  endedAt?: string;
};

type RawHistoryEvent = Omit<HistoryEvent, 'timestamp'> & {
  timestamp: string;
};

type RawAIOperation = Omit<AIOperation, 'timestamp'> & {
  timestamp: string;
};

type RawChatMessage = Omit<ChatMessage, 'timestamp'> & {
  timestamp: string;
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  /** Purge complète du journal (#16) — destructif ; recharge tout après. */
  purgeJournal: () => Promise<{ success: boolean; deletedSessions?: number }>;
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

/** Ce qui appartient au projet ouvert : vidé quand l'écran passe à un autre (S17-1-9). */
const EMPTY_PROJECT_JOURNAL = {
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
  filters: {},
} satisfies Partial<JournalState>;

/** Les lectures qui allument l'indicateur de chargement : seule la dernière partie l'éteint. */
let loadingReads = 0;

/**
 * Une lecture du journal, partie dans le projet à l'écran. Rend la question à poser après chaque
 * attente : son projet a-t-il quitté l'écran ? Sa réponse ne s'inscrit alors pas, ni dans l'autre
 * projet, ni dans celui d'avant revenu après un échec (le main a pu la servir pendant la tentative).
 */
function beginRead(set: StoreApi<JournalState>['setState'], showsLoading: boolean): () => boolean {
  const read = showsLoading ? ++loadingReads : 0;
  const handle = projectLifecycle.capture();
  return () => {
    if (handle?.isCurrent()) return false;
    if (showsLoading && read === loadingReads) set({ loading: false });
    return true;
  };
}

// ============================================================================
// Store Implementation
// ============================================================================

export const useJournalStore = create<JournalState>((set, get) => ({
  // Initial state
  ...EMPTY_PROJECT_JOURNAL,
  hideEmptySessions: true,  // Hide empty sessions by default
  viewScope: 'session',

  // Load all sessions
  loadSessions: async () => {
    const stale = beginRead(set, true);
    set({ loading: true, error: null });
    try {
      const result = await window.electron.history.getSessions();
      if (stale()) return;
      if (result.success) {
        // Parse dates
        const sessions = result.sessions.map((s: RawSession): Session => ({
          ...s,
          startedAt: new Date(s.startedAt),
          endedAt: s.endedAt ? new Date(s.endedAt) : undefined,
        }));
        set({ sessions, loading: false });
      } else {
        set({ error: result.error, loading: false });
      }
    } catch (error) {
      if (stale()) return;
      set({ error: errMsg(error), loading: false });
    }
  },

  purgeJournal: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electron.history.purge();
      if (!result.success) {
        set({ error: result.error, loading: false });
        return { success: false };
      }
      // Tout l'état dérivé est périmé : remise à zéro puis rechargement.
      set({
        selectedSession: null,
        events: [],
        aiOperations: [],
        chatMessages: [],
        allEvents: [],
        allAIOperations: [],
        allChatMessages: [],
      });
      await Promise.all([get().loadSessions(), get().loadStatistics()]);
      return { success: true, deletedSessions: result.deletedSessions };
    } catch (error) {
      set({ error: errMsg(error), loading: false });
      return { success: false };
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
    const stale = beginRead(set, true);
    set({ loading: true });
    try {
      const result = await window.electron.history.getEvents(sessionId);
      if (stale()) return;
      if (result.success) {
        // Parse dates
        const events = result.events.map(
          (e: RawHistoryEvent): HistoryEvent => ({
            ...e,
            timestamp: new Date(e.timestamp),
          })
        );
        set({ events, loading: false });
      } else {
        set({ error: result.error, loading: false });
      }
    } catch (error) {
      if (stale()) return;
      set({ error: errMsg(error), loading: false });
    }
  },

  // Load AI operations for a session
  loadAIOperations: async (sessionId: string) => {
    const stale = beginRead(set, false);
    try {
      const result = await window.electron.history.getAIOperations(sessionId);
      if (stale()) return;
      if (result.success) {
        // Parse dates
        const operations = result.operations.map(
          (op: RawAIOperation): AIOperation => ({
            ...op,
            timestamp: new Date(op.timestamp),
          })
        );
        set({ aiOperations: operations });
      }
    } catch (error) {
      console.error('Failed to load AI operations:', error);
    }
  },

  // Load chat history for a session
  loadChatHistory: async (sessionId: string) => {
    const stale = beginRead(set, false);
    try {
      const result = await window.electron.history.getChatHistory(sessionId);
      if (stale()) return;
      if (result.success) {
        // Parse dates
        const messages = result.messages.map(
          (msg: RawChatMessage): ChatMessage => ({
            ...msg,
            timestamp: new Date(msg.timestamp),
          })
        );
        set({ chatMessages: messages });
      }
    } catch (error) {
      console.error('Failed to load chat history:', error);
    }
  },

  // Load statistics
  loadStatistics: async () => {
    const stale = beginRead(set, false);
    try {
      const result = await window.electron.history.getStatistics();
      if (stale()) return;
      if (result.success) {
        set({ statistics: result.statistics });
      }
    } catch (error) {
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
    } catch (error) {
      set({ error: errMsg(error), loading: false });
    }
  },

  // Set filters
  setFilters: (filters) => {
    set({ filters: { ...get().filters, ...filters } });
  },

  // Search events with filters
  searchEvents: async () => {
    const stale = beginRead(set, true);
    set({ loading: true });
    try {
      const result = await window.electron.history.searchEvents(get().filters);
      if (stale()) return;
      if (result.success) {
        // Parse dates
        const events = result.events.map(
          (e: RawHistoryEvent): HistoryEvent => ({
            ...e,
            timestamp: new Date(e.timestamp),
          })
        );
        set({ events, loading: false });
      } else {
        set({ error: result.error, loading: false });
      }
    } catch (error) {
      if (stale()) return;
      set({ error: errMsg(error), loading: false });
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
    const stale = beginRead(set, true);
    set({ loading: true });
    try {
      const [eventsResult, aiOpsResult, chatResult] = await Promise.all([
        window.electron.history.getAllEvents(),
        window.electron.history.getAllAIOperations(),
        window.electron.history.getAllChatMessages(),
      ]);
      if (stale()) return;

      const allEvents: HistoryEvent[] = eventsResult.success
        ? eventsResult.events.map((e: RawHistoryEvent) => ({
            ...e,
            timestamp: new Date(e.timestamp),
          }))
        : [];

      const allAIOperations: AIOperation[] = aiOpsResult.success
        ? aiOpsResult.operations.map((op: RawAIOperation) => ({
            ...op,
            timestamp: new Date(op.timestamp),
          }))
        : [];

      const allChatMessages: ChatMessage[] = chatResult.success
        ? chatResult.messages.map((msg: RawChatMessage) => ({
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
    } catch (error) {
      if (stale()) return;
      set({ error: errMsg(error), loading: false });
    }
  },
}));

// Les sessions, la session sélectionnée et ce qu'elle montre appartiennent au projet : le panneau du
// projet suivant les affichait sous son nom (S17-1-9). Les préférences d'affichage restent.
projectLifecycle.onReset('journal', () => useJournalStore.setState({ ...EMPTY_PROJECT_JOURNAL }));
