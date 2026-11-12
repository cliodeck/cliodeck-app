// @vitest-environment jsdom
/**
 * ContextGraph : un appel au graphe par ensemble de documents cités, plus un par jeton (S16-1-9).
 *
 * L'effet dépendait du tableau `messages`, que chaque `appendDelta` remplace : pendant une réponse,
 * chaque jeton relançait `corpus:get-subgraph` avec les mêmes documents, et le main reconstruisait
 * tout le graphe du corpus pour chacun.
 *
 * Vrais composant, `chatStore` et registre de projet ; seul le pont `window.electron.corpus` est
 * simulé.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ContextGraph } from '../ContextGraph';
import { useChatStore, type BrainstormSource } from '../../../stores/chatStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';

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

/** Un tour complet de l'assistant, en autant de rendus que dans l'app. */
async function turn(question: string, docs: string[], tokens = 3): Promise<void> {
  const store = useChatStore.getState();
  await act(async () => { store.appendUser(question); });
  let id = '';
  await act(async () => { id = store.beginAssistant('session'); });
  await act(async () => { store.setSources(id, docs.map(source)); });
  for (let i = 0; i < tokens; i += 1) {
    await act(async () => { store.appendDelta(id, `mot${i} `); });
  }
  await act(async () => { store.finishAssistant(id, 'stop'); });
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
    await turn('Qui était le préfet ?', ['d1', 'd2']);
    expect(getSubgraph).toHaveBeenCalledTimes(1);

    await turn('Et le maire ?', ['d3', 'd1']);
    expect(getSubgraph).toHaveBeenCalledTimes(2);
    expect(getSubgraph).toHaveBeenLastCalledWith(['d1', 'd2', 'd3']);
    expect(container.querySelector('.context-graph__summary')?.textContent).toContain('(3)');

    // Mêmes documents, autre ordre et doublons : l'ensemble n'a pas changé.
    await turn('Et le conseil ?', ['d3', 'd2', 'd1', 'd2']);
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
