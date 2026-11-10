// @vitest-environment jsdom
/**
 * Changer de projet remonte l'explorateur de corpus (L03-4, seconde partie ; S13-1-29).
 *
 * L'explorateur ne repartait à zéro que lorsque plus aucun projet n'était ouvert. De A à B, les
 * thèmes et la frise de A restaient à l'écran (B, jamais analysé, n'en renvoie pas), comme les
 * filtres et le nœud sélectionné : le graphe de B était filtré sur les années de A, et les exports
 * de thèmes mêlaient ceux de A aux documents de B.
 *
 * Vrais panneau Explorer, explorateur, sections et `useCorpusData` ; le main est simulé, par projet.
 * Seuls les dessins sont remplacés : le graphe (canvas) par un bouton par nœud, la frise (recharts)
 * par la liste de ses années.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ExplorePanel } from '../ExplorePanel';
import { useProjectStore } from '../../../stores/projectStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';
import type { GraphData, GraphNode, TopicAnalysisResult } from '../../Corpus/corpus-types';

vi.mock('react-force-graph-2d', () => ({
  default: ({ graphData, onNodeClick }: { graphData: { nodes: GraphNode[] }; onNodeClick: (node: GraphNode) => void }) => (
    <div>
      {graphData.nodes.map((node) => (
        <button key={node.id} type="button" onClick={() => onNodeClick(node)}>
          {`nœud ${node.label}`}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('../../Corpus/TopicTimeline', () => ({
  TopicTimeline: ({ timelineData }: { timelineData: Array<{ year: number }> }) => (
    <p>{`frise ${timelineData.map((point) => point.year).join(' ')}`}</p>
  ),
}));

const A = '/projets/A';
const B = '/projets/B';

const doc = (id: string, label: string, author: string, year: string): GraphNode => ({
  id,
  type: 'document',
  label,
  metadata: { title: label, author, year },
});

interface ServedCorpus {
  graph: GraphData;
  topics: (TopicAnalysisResult & { success: true }) | { success: false; error: string };
  timeline?: Array<{ year: number; [topic: string]: number }>;
}

const CORPUS: Record<string, ServedCorpus> = {
  [A]: {
    graph: {
      nodes: [doc('a1', 'Ports baltes', 'Dupont', '1990'), doc('a2', 'Danzig libre', 'Martin', '2000')],
      edges: [],
    },
    topics: {
      success: true,
      topics: [{ id: 0, keywords: ['port', 'baltique', 'commerce'], size: 2 }],
      topicAssignments: { a1: 0, a2: 0 },
      options: { nrTopics: 5 },
    },
    timeline: [{ year: 1990, 0: 1 }, { year: 2000, 0: 1 }],
  },
  // B n'a jamais été analysé : le main répond une erreur, comme `corpus:load-topics` sans analyse enregistrée.
  [B]: {
    graph: {
      nodes: [doc('b1', 'Gdańsk 1945', 'Nowak', '1990'), doc('b2', 'Ville libre', 'Kowalski', '2010')],
      edges: [],
    },
    topics: { success: false, error: 'No saved topic analysis' },
  },
};

/** Le projet que le main sert. */
let mainProject: string | null = null;

function served(): ServedCorpus {
  if (!mainProject) throw new Error('aucun projet servi par le main');
  return CORPUS[mainProject];
}

function installElectron(): void {
  const electron = (window as unknown as { electron: Record<string, unknown> }).electron;
  electron.config = { get: async () => ({}) };
  // Une réponse IPC est une copie neuve à chaque appel, jamais l'objet de l'appel d'avant.
  electron.corpus = {
    getStatistics: async () => ({
      success: true,
      statistics: {
        documentCount: served().graph.nodes.length,
        chunkCount: 10,
        citationCount: 0,
        totalCitationsExtracted: 0,
        languageCount: 1,
        languages: ['fr'],
        yearRange: null,
        authorCount: served().graph.nodes.length,
      },
    }),
    getGraph: async () => ({ success: true, graph: structuredClone(served().graph) }),
    loadTopics: async () => structuredClone(served().topics),
    getTopicTimeline: async () =>
      served().timeline
        ? { success: true, timeline: structuredClone(served().timeline) }
        : { success: false, error: 'no timeline' },
  };
}

/**
 * Le projet `dir` à l'écran, comme `openProjectContents` le pose : le main le sert déjà, les stores
 * du projet d'avant se vident, puis `currentProject` est remplacé d'un seul coup, sans passer par null.
 */
function show(dir: string): void {
  mainProject = dir;
  projectLifecycle.enter(dir);
  useProjectStore.setState({
    currentProject: {
      id: dir,
      name: dir,
      path: dir,
      type: 'article',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
  });
}

/** Une section repliée de l'explorateur se déplie, si elle ne l'est pas déjà. */
async function expand(title: string, inside: string): Promise<void> {
  if (screen.queryByText(inside)) return;
  await act(async () => {
    fireEvent.click(screen.getByText(title));
  });
}

function yearFilter(): HTMLSelectElement {
  const found = screen.getByText('corpus.year').parentElement?.querySelector('select');
  if (!found) throw new Error('pas de filtre par année');
  return found;
}

/** Dans A : thèmes chargés, filtre « 1990 » posé, nœud « Ports baltes » sélectionné. */
async function workInA(): Promise<void> {
  show(A);
  await act(async () => {
    render(<ExplorePanel />);
  });
  await screen.findByText('nœud Ports baltes');
  await expand('corpus.filters', 'corpus.year');
  await act(async () => {
    fireEvent.change(yearFilter(), { target: { value: '1990' } });
  });
  await waitFor(() => expect(screen.queryByText('nœud Danzig libre')).toBeNull());
  await act(async () => {
    fireEvent.click(screen.getByText('nœud Ports baltes'));
  });
  expect(screen.getByText('corpus.nodeDetails')).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Topic 0: port, baltique, commerce' })).toBeInTheDocument();
}

beforeEach(() => {
  installElectron();
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ currentProject: null });
  mainProject = null;
});

describe('explorateur de corpus : changer de projet repart à zéro (S13-1-29)', () => {
  it('de A à B : ni filtre, ni nœud, ni thèmes, ni frise de A', async () => {
    await workInA();

    await act(async () => show(B));
    await screen.findByText('nœud Gdańsk 1945');

    // Le filtre « 1990 » de A cachait le document de 2010 de B.
    expect(screen.getByText('nœud Ville libre')).toBeInTheDocument();
    expect(screen.queryByText('corpus.nodeDetails')).toBeNull();
    await expand('corpus.filters', 'corpus.year');
    expect(yearFilter().value).toBe('');
    expect(screen.queryByRole('option', { name: /^Topic 0/ })).toBeNull();
    await expand('corpus.topicAnalysis', 'corpus.noTopicAnalysis');
    expect(screen.getByText('corpus.noTopicAnalysis')).toBeInTheDocument();
    expect(screen.queryByText(/^frise/)).toBeNull();
  });

  it('le même projet, objet remplacé (style CSL, même dossier rouvert) : filtre et nœud restent', async () => {
    await workInA();

    await act(async () => useProjectStore.getState().patchCurrentProject({ cslPath: `${A}/chicago.csl` }));
    await act(async () => show(A));
    await screen.findByText('nœud Ports baltes');

    expect(screen.queryByText('nœud Danzig libre')).toBeNull();
    expect(screen.getByText('corpus.nodeDetails')).toBeInTheDocument();
  });
});
