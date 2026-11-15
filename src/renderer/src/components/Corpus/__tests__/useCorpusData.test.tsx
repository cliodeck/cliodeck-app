// @vitest-environment jsdom
/**
 * Le graphe filtré de l'explorateur suit la nouvelle analyse des thèmes (S13-1-30), et garde ses
 * liens une fois affiché (S13-2-1).
 *
 * Le filtre par thème lit les affectations de l'analyse, mais le graphe filtré ne se recalculait qu'au
 * changement d'un filtre ou du graphe complet : après « Réanalyser », il montrait encore les documents
 * de l'ancien thème 3, alors que la liste montrait le nouveau. Un thème que la nouvelle analyse n'a
 * plus restait choisi, et ne filtrait plus que du vide.
 *
 * Vrai `useCorpusData` ; le main est simulé. `analyzeTopics` y rend l'analyse que le main a
 * enregistrée (L02-10) : c'est sur elle que le filtre se règle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
// @ts-expect-error d3-force-3d ne publie pas de types ; c'est le paquet que force-graph emploie.
import { forceLink as untypedForceLink } from 'd3-force-3d';
import { useCorpusData } from '../useCorpusData';
import { edgeEndpointId } from '../corpus-filters';
import { useProjectStore } from '../../../stores/projectStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';
import type { GraphData, GraphEdge, GraphNode } from '../corpus-types';

const forceLink = untypedForceLink as (links: GraphEdge[]) => {
  id(accessor: (node: GraphNode) => string): { initialize(nodes: GraphNode[]): void };
};

const t = (key: string): string => key;

const A = '/projets/A';

const doc = (id: string, year: string): GraphNode => ({
  id,
  type: 'document',
  label: id,
  metadata: { title: id, author: 'Dupont', year },
});

const similarity = (source: string, target: string): GraphEdge => ({ source, target, type: 'similarity', weight: 0.8 });

const GRAPH: GraphData = {
  nodes: [doc('a1', '1990'), doc('a2', '1990'), doc('a3', '2000')],
  edges: [similarity('a1', 'a2'), similarity('a2', 'a3'), similarity('a1', 'a3')],
};

const topic = (id: number) => ({ id, keywords: [`mot-${id}`], size: 1 });

/** L'analyse enregistrée à l'ouverture : le thème 3 réunit a1 et a2. */
const SAVED = {
  success: true,
  topics: [topic(3), topic(4)],
  topicAssignments: { a1: 3, a2: 3, a3: 4 },
};

type Answer = Record<string, unknown>;

function installCorpus(analyzeTopics: () => Promise<Answer>): void {
  const w = window as unknown as { electron: Record<string, unknown> };
  w.electron = {
    ...w.electron,
    config: { get: vi.fn(async () => ({})) },
    corpus: {
      getStatistics: vi.fn(async () => ({ success: false })),
      // Une réponse IPC est une copie neuve à chaque appel.
      getGraph: vi.fn(async () => ({ success: true, graph: structuredClone(GRAPH) })),
      loadTopics: vi.fn(async () => structuredClone(SAVED)),
      analyzeTopics: vi.fn(analyzeTopics),
      getTopicTimeline: vi.fn(async () => ({ success: false })),
    },
  };
}

const ids = (graph: GraphData | null): string[] => (graph?.nodes ?? []).map((node) => node.id);
const ends = (graph: GraphData | null): string[] =>
  (graph?.edges ?? []).map((edge) => `${edgeEndpointId(edge.source)}-${edgeEndpointId(edge.target)}`);

beforeEach(() => {
  projectLifecycle.enter(A);
  useProjectStore.setState({
    currentProject: { id: A, name: A, path: A, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
    loadState: { kind: 'ready', path: A, loadedAt: '' },
  } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  projectLifecycle.enter(null);
  useProjectStore.setState({ currentProject: null, loadState: { kind: 'idle' } } as never);
});

/** L'explorateur de A, chargé, filtré sur le thème 3. */
async function filteredOnTopic3() {
  const hook = renderHook(() => useCorpusData());
  await act(async () => undefined);
  await act(async () => {
    hook.result.current.setFilters({ ...hook.result.current.filters, topic: 3 });
  });
  expect(ids(hook.result.current.graphData)).toEqual(['a1', 'a2']);
  return hook;
}

async function reanalyze(hook: Awaited<ReturnType<typeof filteredOnTopic3>>): Promise<void> {
  await act(async () => {
    await hook.result.current.loadTopics(t);
  });
}

describe('useCorpusData : une nouvelle analyse des thèmes refiltre le graphe (S13-1-30)', () => {
  it('le thème 3 existe toujours, avec d’autres documents : le graphe montre les nouveaux', async () => {
    installCorpus(async () => ({
      success: true,
      topics: [topic(3), topic(4)],
      topicAssignments: { a1: 4, a2: 4, a3: 3 },
    }));
    const hook = await filteredOnTopic3();

    await reanalyze(hook);

    expect(hook.result.current.filters.topic).toBe(3);
    expect(ids(hook.result.current.graphData)).toEqual(['a3']);
  });

  it('le thème 3 a disparu : le filtre revient à « Tous », et tout le corpus revient', async () => {
    installCorpus(async () => ({
      success: true,
      topics: [topic(0), topic(1)],
      topicAssignments: { a1: 0, a2: 1, a3: 1 },
    }));
    const hook = await filteredOnTopic3();

    await reanalyze(hook);

    expect(hook.result.current.filters.topic).toBeNull();
    expect(ids(hook.result.current.graphData)).toEqual(['a1', 'a2', 'a3']);
  });

  it('les autres filtres restent posés quand le thème disparaît', async () => {
    installCorpus(async () => ({ success: true, topics: [topic(0)], topicAssignments: { a1: 0, a2: 0, a3: 0 } }));
    const hook = renderHook(() => useCorpusData());
    await act(async () => undefined);
    await act(async () => {
      hook.result.current.setFilters({ year: 1990, author: null, language: null, topic: 3 });
    });

    await reanalyze(hook);

    expect(hook.result.current.filters).toEqual({ year: 1990, author: null, language: null, topic: null });
    expect(ids(hook.result.current.graphData)).toEqual(['a1', 'a2']);
  });
});

describe('useCorpusData : un graphe affiché garde ses liens quand on filtre (S13-2-1)', () => {
  it('filtre Année puis « Réinitialiser » : le lien de 1990, puis tous les liens', async () => {
    installCorpus(async () => SAVED);
    const hook = renderHook(() => useCorpusData());
    await act(async () => undefined);
    // Ce que force-graph fait des arêtes qu'il reçoit : les mêmes objets que le graphe complet.
    const shown = hook.result.current.graphData as GraphData;
    forceLink(shown.edges)
      .id((node) => node.id)
      .initialize(shown.nodes);

    await act(async () => {
      hook.result.current.setFilters({ ...hook.result.current.filters, year: 1990 });
    });
    expect(ends(hook.result.current.graphData)).toEqual(['a1-a2']);

    await act(async () => {
      hook.result.current.clearFilters();
    });
    expect(ends(hook.result.current.graphData)).toEqual(['a1-a2', 'a2-a3', 'a1-a3']);
  });
});
