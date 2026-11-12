// @vitest-environment jsdom
/**
 * ContextGraph : un appel au graphe par ensemble de documents cités, plus un par jeton (S16-1-9).
 *
 * L'effet dépendait du tableau `messages`, que chaque `appendDelta` remplace : pendant une réponse,
 * chaque jeton relançait `corpus:get-subgraph` avec les mêmes documents, et le main reconstruisait
 * tout le graphe du corpus pour chacun.
 *
 * Vrais composant, `chatStore` et registre de projet ; seul le pont `window.electron` est simulé.
 * Le dernier test rend le graphe dans son vrai parent, `AssistantChat`, qui s'abonne aux messages et
 * se rend donc à chaque jeton.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ContextGraph } from '../ContextGraph';
import { AssistantChat } from '../../Chat/AssistantChat';
import { useChatStore, type BrainstormSource } from '../../../stores/chatStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';

// Voisins lourds d'AssistantChat, sans rapport avec le graphe (comme AssistantChat.full.test.tsx).
vi.mock('../../Chat/RAGSettingsPanel', () => ({ RAGSettingsPanel: () => null }));
vi.mock('../../Chat/ModeSelector', () => ({ ModeSelector: () => null }));
vi.mock('../../Chat/useChatSettingsProjection', () => ({
  useChatSettingsProjection: () => undefined,
}));

// Le mock de vitest.setup.ts, plus un compteur : le titre du graphe est la seule lecture de cette
// clé, une par rendu du graphe affiché.
const graphRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (key === 'chat.brainstorm.contextGraph') graphRenders.count += 1;
      return typeof fallback === 'string' ? fallback : key;
    },
    i18n: { language: 'fr', changeLanguage: async () => undefined },
  }),
  Trans: ({ children }: { children?: unknown }) => children ?? null,
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

interface SubgraphReply {
  success: boolean;
  graph?: {
    nodes: Array<{ id: string; type: 'document'; label: string; metadata: Record<string, unknown>; x: number; y: number }>;
    edges: [];
  };
}

function graphOf(ids: string[]): SubgraphReply {
  return {
    success: true,
    graph: {
      nodes: ids.map((id, i) => ({ id, type: 'document', label: `Doc ${id}`, metadata: {}, x: i * 150, y: 0 })),
      edges: [],
    },
  };
}

function source(documentId: string): BrainstormSource {
  return {
    kind: 'bibliographie',
    sourceType: 'secondary',
    title: `Doc ${documentId}`,
    snippet: '…',
    similarity: 0.5,
    documentId,
  };
}

let getSubgraph: Mock<(ids: string[]) => Promise<SubgraphReply>>;
let originalElectron: unknown;

/** Un tour complet de l'assistant, en autant de rendus que dans l'app. Rend l'id de la réponse. */
async function turn(question: string, docs: string[], tokens = 3): Promise<string> {
  const store = useChatStore.getState();
  await act(async () => { store.appendUser(question); });
  let id = '';
  await act(async () => { id = store.beginAssistant('session'); });
  await act(async () => { store.setSources(id, docs.map(source)); });
  for (let i = 0; i < tokens; i += 1) {
    await act(async () => { store.appendDelta(id, `mot${i} `); });
  }
  await act(async () => { store.finishAssistant(id, 'stop'); });
  return id;
}

beforeEach(() => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  getSubgraph = vi.fn(async (ids: string[]) => graphOf(ids));
  (window as unknown as { electron: unknown }).electron = { corpus: { getSubgraph } };
  projectLifecycle.enter('/projets/A');
  useChatStore.getState().reset();
});

afterEach(() => {
  cleanup();
  projectLifecycle.enter(null);
  (window as unknown as { electron?: unknown }).electron = originalElectron;
});

describe('ContextGraph — un appel par ensemble de documents cités (S16-1-9)', () => {
  it('2 documents cités, puis 50 jetons d’une réponse : un seul appel au graphe', async () => {
    const { container } = render(<ContextGraph />);
    await turn('Qui était le préfet ?', ['d2', 'd1']);
    expect(container.querySelector('.context-graph__summary')?.textContent).toContain('(2)');

    // Second tour : la réponse arrive jeton par jeton, sans nouvelle source.
    const store = useChatStore.getState();
    await act(async () => { store.appendUser('Et en 1936 ?'); });
    let id = '';
    await act(async () => { id = store.beginAssistant('session'); });
    const before = getSubgraph.mock.calls.length;
    for (let i = 0; i < 50; i += 1) {
      await act(async () => { store.appendDelta(id, `mot${i} `); });
    }
    expect(getSubgraph.mock.calls.length - before).toBe(0);
    expect(getSubgraph).toHaveBeenCalledTimes(1);
    expect(getSubgraph).toHaveBeenLastCalledWith(['d1', 'd2']);
    expect(container.querySelector('.context-graph__summary')?.textContent).toContain('(2)');
  });

  it('un troisième document : un deuxième appel ; les mêmes documents dans un autre ordre, aucun', async () => {
    const { container } = render(<ContextGraph />);
    const first = await turn('Qui était le préfet ?', ['d1', 'd2']);
    expect(getSubgraph).toHaveBeenCalledTimes(1);

    await turn('Et le maire ?', ['d3', 'd1']);
    expect(getSubgraph).toHaveBeenCalledTimes(2);
    expect(getSubgraph).toHaveBeenLastCalledWith(['d1', 'd2', 'd3']);
    expect(container.querySelector('.context-graph__summary')?.textContent).toContain('(3)');

    // Doublons et documents déjà cités : l'ensemble n'a pas changé.
    await turn('Et le conseil ?', ['d3', 'd2', 'd1', 'd2']);
    expect(getSubgraph).toHaveBeenCalledTimes(2);

    // Autre ordre : le premier message, qui fixe l'ordre de première apparition, réordonne ses
    // sources. Sans le tri, la clé deviendrait ["d2","d1","d3"] et le main serait rappelé.
    await act(async () => { useChatStore.getState().setSources(first, [source('d2'), source('d1')]); });
    expect(getSubgraph).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.context-graph__summary')?.textContent).toContain('(3)');
  });

  it('changer de projet efface le graphe du projet quitté', async () => {
    const { container } = render(<ContextGraph />);
    await turn('Qui était le préfet ?', ['d1', 'd2']);
    expect(container.querySelector('.context-graph')).not.toBeNull();

    await act(async () => {
      projectLifecycle.beginTransition();
      projectLifecycle.enter('/projets/B');
    });
    expect(container.querySelector('.context-graph')).toBeNull();
  });

  it('une réponse du graphe partie pour le projet quitté ne s’affiche pas dans le suivant', async () => {
    let answer: (reply: SubgraphReply) => void = () => {};
    getSubgraph.mockImplementationOnce(
      () => new Promise<SubgraphReply>((resolve) => { answer = resolve; })
    );
    const { container } = render(<ContextGraph />);
    await turn('Qui était le préfet ?', ['d1', 'd2']);
    expect(getSubgraph).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.context-graph')).toBeNull();

    await act(async () => {
      projectLifecycle.beginTransition();
      projectLifecycle.enter('/projets/B');
    });
    await act(async () => { answer(graphOf(['d1', 'd2'])); });
    expect(container.querySelector('.context-graph')).toBeNull();
    expect(getSubgraph).toHaveBeenCalledTimes(1);
  });
});

describe('ContextGraph dans AssistantChat, qui se rend à chaque jeton', () => {
  type ChunkCb = (env: { sessionId: string; chunk: { delta: string; done?: boolean; finishReason?: string } }) => void;
  type ContextCb = (env: { sessionId: string; sources: BrainstormSource[] }) => void;

  let emitChunk: ChunkCb = () => {};
  let emitContext: ContextCb = () => {};
  let sessions = 0;
  let start: Mock<() => Promise<{ success: boolean; sessionId: string }>>;

  beforeEach(() => {
    graphRenders.count = 0;
    sessions = 0;
    start = vi.fn(async () => ({ success: true, sessionId: `sess-${++sessions}` }));
    (window as unknown as { electron: unknown }).electron = {
      fusion: {
        chat: {
          start,
          cancel: vi.fn(async () => ({ success: true, cancelled: true })),
          onChunk: vi.fn((cb: ChunkCb) => { emitChunk = cb; return () => undefined; }),
          onContext: vi.fn((cb: ContextCb) => { emitContext = cb; return () => undefined; }),
          onToolCall: vi.fn(() => () => undefined),
          onExplanation: vi.fn(() => () => undefined),
          onStatus: vi.fn(() => () => undefined),
        },
      },
      config: { get: vi.fn(async () => null) },
      corpus: { getSubgraph },
    };
  });

  /** Un tour par la vraie saisie et le vrai transport du chat, contexte puis `tokens` jetons. */
  async function chatTurn(docs: string[], tokens: number): Promise<void> {
    const before = start.mock.calls.length;
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Qui était le préfet ?' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(before + 1));
    await waitFor(() => expect(useChatStore.getState().pendingAssistantId).not.toBeNull());
    const sessionId = `sess-${sessions}`;
    await act(async () => { emitContext({ sessionId, sources: docs.map(source) }); });
    for (let i = 0; i < tokens; i += 1) {
      await act(async () => { emitChunk({ sessionId, chunk: { delta: `mot${i} ` } }); });
    }
    await act(async () => { emitChunk({ sessionId, chunk: { delta: '', done: true, finishReason: 'stop' } }); });
  }

  it('50 jetons d’une réponse : ni appel au graphe, ni rendu du graphe', async () => {
    render(<AssistantChat variant="full" />);
    await chatTurn(['d2', 'd1'], 0);
    expect(document.querySelector('.context-graph__summary')?.textContent).toContain('(2)');
    expect(graphRenders.count).toBeGreaterThan(0);

    const rendersBefore = graphRenders.count;
    await chatTurn(['d1', 'd2'], 50);
    expect(useChatStore.getState().messages.at(-1)?.content).toContain('mot49');
    expect(getSubgraph).toHaveBeenCalledTimes(1);
    expect(graphRenders.count - rendersBefore).toBe(0);
    expect(document.querySelector('.context-graph__summary')?.textContent).toContain('(2)');
  });
});
