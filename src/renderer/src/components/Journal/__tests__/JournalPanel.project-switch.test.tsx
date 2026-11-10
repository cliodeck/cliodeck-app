// @vitest-environment jsdom
/**
 * Journal de recherche : changer de projet, panneau ouvert, montre les sessions du projet entrant
 * (S17-1-9).
 *
 * Le panneau restait sur l'onglet « Historique du chat » de la session de A. Son store vidé, il
 * n'aurait plus montré qu'une zone vide, onglets désactivés : la liste des sessions de B ne
 * s'affichait qu'en revenant à la main sur l'onglet Sessions.
 *
 * Vrais panneau, store et registre ; seul le pont `window.electron.history` est simulé, par projet.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { JournalPanel } from '../JournalPanel';
import { useJournalStore } from '../../../stores/journalStore';
import { useProjectStore } from '../../../stores/projectStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';

type Served = 'A' | 'B';
let served: Served;
let originalElectron: unknown;
const INITIAL_JOURNAL = useJournalStore.getState();

const project = (p: Served) => ({
  id: p,
  name: `Projet ${p}`,
  path: `/projets/${p}`,
  type: 'article' as const,
  createdAt: new Date(),
  lastOpenedAt: new Date(),
});

const SESSIONS: Record<Served, unknown[]> = {
  A: [{ id: 'session-a', projectPath: '/projets/A', startedAt: '2026-11-01T09:00:00Z', eventCount: 3 }],
  B: [{ id: 'session-b', projectPath: '/projets/B', startedAt: '2026-11-02T14:00:00Z', eventCount: 7 }],
};

function show(p: Served | null): void {
  projectLifecycle.enter(p ? project(p).path : null);
  useProjectStore.setState({ currentProject: p ? project(p) : null });
}

beforeEach(() => {
  served = 'A';
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  (window as unknown as { electron: unknown }).electron = {
    history: {
      getSessions: vi.fn(async () => ({ success: true, sessions: SESSIONS[served] })),
      getStatistics: vi.fn(async () => ({ success: true, statistics: null })),
      getEvents: vi.fn(async () => ({ success: true, events: [] })),
      getAIOperations: vi.fn(async () => ({ success: true, operations: [] })),
      getChatHistory: vi.fn(async () => ({
        success: true,
        messages: [
          { id: 'm1', sessionId: 'session-a', role: 'user', content: 'Qui était le préfet en 1934 ?', timestamp: '2026-11-01T09:01:00Z' },
        ],
      })),
    },
  };
  useJournalStore.setState({ ...INITIAL_JOURNAL, hideEmptySessions: false }, true);
  show('A');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  show(null);
  (window as unknown as { electron?: unknown }).electron = originalElectron;
});

it('onglet « Historique du chat » d’une session de A, puis le projet B : la liste des sessions de B', async () => {
  const { container } = render(<JournalPanel />);
  await waitFor(() => expect(container.querySelectorAll('.session-card')).toHaveLength(1));
  fireEvent.click(container.querySelector('.session-card')!);
  await waitFor(() => expect(useJournalStore.getState().chatMessages).toHaveLength(1));
  fireEvent.click(screen.getByText('journal.chatHistory'));
  expect(screen.getByText('Qui était le préfet en 1934 ?')).toBeInTheDocument();

  await act(async () => {
    projectLifecycle.beginTransition();
    served = 'B';
    show('B');
  });

  await waitFor(() => expect(screen.getByText('journal.sessionsTab').className).toBe('active'));
  await waitFor(() => expect(container.querySelectorAll('.session-card')).toHaveLength(1));
  expect(screen.getByText(/7 journal\.events/)).toBeInTheDocument();
  expect(screen.queryByText('Qui était le préfet en 1934 ?')).not.toBeInTheDocument();
});
