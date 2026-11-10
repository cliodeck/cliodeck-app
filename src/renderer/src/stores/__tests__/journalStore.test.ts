// @vitest-environment jsdom
/**
 * Le journal de recherche montre les sessions du projet ouvert, et rien d'autre (S17-1-9).
 *
 * La session sélectionnée dans A, ses événements, ses opérations IA et ses messages restaient dans
 * le store : le panneau du projet B les affichait sous son nom. Et une lecture partie dans A,
 * arrivée après la bascule, s'inscrivait dans B.
 *
 * Vrais store et registre ; seul le pont `window.electron.history` est simulé.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useJournalStore, type Session } from '../journalStore';
import { projectLifecycle } from '../../lifecycle/projectLifecycle';

const SESSION_A: Session = {
  id: 'session-a',
  projectPath: '/projets/A',
  startedAt: new Date('2026-11-01T09:00:00Z'),
  eventCount: 3,
};

let history: Record<string, ReturnType<typeof vi.fn>>;
let originalElectron: unknown;

function held<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function switchTo(path: string | null): void {
  projectLifecycle.beginTransition();
  projectLifecycle.enter(path);
}

const message = (content: string) => ({
  id: `m-${content}`,
  sessionId: 'session-a',
  role: 'user',
  content,
  timestamp: '2026-11-01T09:01:00Z',
});

beforeEach(() => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  history = {
    getSessions: vi.fn(async () => ({ success: true, sessions: [] })),
    getEvents: vi.fn(async () => ({ success: true, events: [] })),
    getAIOperations: vi.fn(async () => ({ success: true, operations: [] })),
    getChatHistory: vi.fn(async () => ({ success: true, messages: [] })),
    getStatistics: vi.fn(async () => ({ success: true, statistics: null })),
  };
  (window as unknown as { electron: unknown }).electron = { history };
  projectLifecycle.enter('/projets/A');
  useJournalStore.setState({
    sessions: [SESSION_A],
    selectedSession: SESSION_A,
    events: [{ id: 'e1', sessionId: 'session-a', eventType: 'chat_message', timestamp: new Date() }],
    aiOperations: [
      { id: 'op1', sessionId: 'session-a', operationType: 'rag_query', timestamp: new Date(), success: true },
    ],
    chatMessages: [{ ...message('Qui était le préfet ?'), role: 'user', timestamp: new Date() }],
    statistics: { totalSessions: 1, totalEvents: 3, totalChatMessages: 1, totalAIOperations: 1, averageSessionDuration: 0 },
    allEvents: [{ id: 'e1', sessionId: 'session-a', eventType: 'chat_message', timestamp: new Date() }],
    allAIOperations: [
      { id: 'op1', sessionId: 'session-a', operationType: 'rag_query', timestamp: new Date(), success: true },
    ],
    allChatMessages: [{ ...message('Qui était le préfet ?'), role: 'user', timestamp: new Date() }],
    error: 'Lecture du journal impossible',
    filters: { searchQuery: 'préfet' },
    loading: false,
    hideEmptySessions: false,
    viewScope: 'project',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { electron?: unknown }).electron = originalElectron;
});

describe('journalStore — changement de projet', () => {
  it('session sélectionnée, événements, opérations, messages et sessions de A disparaissent', () => {
    switchTo('/projets/B');

    const state = useJournalStore.getState();
    expect(state.selectedSession).toBeNull();
    expect(state.sessions).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.aiOperations).toEqual([]);
    expect(state.chatMessages).toEqual([]);
    expect(state.allEvents).toEqual([]);
    expect(state.allAIOperations).toEqual([]);
    expect(state.allChatMessages).toEqual([]);
    expect(state.statistics).toBeNull();
    expect(state.error).toBeNull();
    expect(state.filters).toEqual({});
    expect(state.loading).toBe(false);
  });

  it('les préférences d’affichage restent', () => {
    switchTo('/projets/B');

    expect(useJournalStore.getState().hideEmptySessions).toBe(false);
    expect(useJournalStore.getState().viewScope).toBe('project');
  });

  it('le même projet rouvert garde sa session sélectionnée', () => {
    switchTo('/projets/A');

    expect(useJournalStore.getState().selectedSession?.id).toBe('session-a');
  });

  it('loadEvents parti dans A, arrivé après le passage à B : rien ne s’inscrit', async () => {
    const response = held<unknown>();
    history.getEvents.mockReturnValueOnce(response.promise);
    const loading = useJournalStore.getState().loadEvents('session-a');

    switchTo('/projets/B');
    response.release({
      success: true,
      events: [{ id: 'e2', sessionId: 'session-a', eventType: 'chat_message', timestamp: '2026-11-01T09:02:00Z' }],
    });
    await loading;

    expect(useJournalStore.getState().events).toEqual([]);
    expect(useJournalStore.getState().loading).toBe(false);
  });

  it.each([
    ['loadSessions', () => useJournalStore.getState().loadSessions(), 'getSessions', { success: true, sessions: [{ ...SESSION_A, startedAt: '2026-11-01T09:00:00Z' }] }],
    ['loadChatHistory', () => useJournalStore.getState().loadChatHistory('session-a'), 'getChatHistory', { success: true, messages: [message('Encore A')] }],
    ['loadAIOperations', () => useJournalStore.getState().loadAIOperations('session-a'), 'getAIOperations', { success: true, operations: [{ id: 'op2', sessionId: 'session-a', operationType: 'rag_query', timestamp: '2026-11-01T09:02:00Z', success: true }] }],
    ['loadStatistics', () => useJournalStore.getState().loadStatistics(), 'getStatistics', { success: true, statistics: { totalSessions: 9, totalEvents: 9, totalChatMessages: 9, totalAIOperations: 9, averageSessionDuration: 0 } }],
  ] as const)('%s parti dans A, arrivé après le passage à B : rien ne s’inscrit', async (_name, load, channel, value) => {
    const response = held<unknown>();
    history[channel].mockReturnValueOnce(response.promise);
    const loading = load();

    switchTo('/projets/B');
    response.release(value);
    await loading;

    const state = useJournalStore.getState();
    expect(state.sessions).toEqual([]);
    expect(state.chatMessages).toEqual([]);
    expect(state.aiOperations).toEqual([]);
    expect(state.statistics).toBeNull();
  });

  it('A revient après l’échec de B : la lecture ignorée pendant la tentative ne laisse pas de chargement en cours', async () => {
    const response = held<unknown>();
    history.getSessions.mockReturnValueOnce(response.promise);
    const loading = useJournalStore.getState().loadSessions();

    projectLifecycle.beginTransition();
    projectLifecycle.abortTransition();
    response.release({ success: true, sessions: [] });
    await loading;

    expect(useJournalStore.getState().sessions).toEqual([SESSION_A]);
    expect(useJournalStore.getState().loading).toBe(false);
  });

  it('témoin : une lecture partie et reçue dans le même projet s’inscrit', async () => {
    history.getChatHistory.mockResolvedValueOnce({ success: true, messages: [message('Réponse de A')] });

    await useJournalStore.getState().loadChatHistory('session-a');

    expect(useJournalStore.getState().chatMessages.map((m) => m.content)).toEqual(['Réponse de A']);
  });
});
