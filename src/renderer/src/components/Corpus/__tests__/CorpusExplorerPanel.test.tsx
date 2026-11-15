// @vitest-environment jsdom
/**
 * Une combinaison de filtres sans document ne se fait plus passer pour un corpus vide (S18-1-6).
 *
 * L'explorateur testait le graphe filtré pour décider que le corpus était vide. Les menus Année et
 * Auteur proposent toutes les valeurs du corpus : « 2000 » puis un auteur qui n'a rien publié cette
 * année-là remplaçait tout le panneau, filtres et « Réinitialiser » compris, par « Corpus vide —
 * Indexez au moins 2 documents PDF ». Il fallait changer de mode et revenir pour en sortir.
 *
 * Vrais explorateur, sections et `useCorpusData` ; le main est simulé. Seul le graphe (canvas) est
 * remplacé, par un bouton par nœud.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CorpusExplorerPanel } from '../CorpusExplorerPanel';
import { useProjectStore } from '../../../stores/projectStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';
import type { GraphData, GraphNode } from '../corpus-types';

vi.mock('react-force-graph-2d', () => ({
  default: ({ graphData }: { graphData: { nodes: GraphNode[] } }) => (
    <div>
      {graphData.nodes.map((node) => (
        <button key={node.id} type="button">{`nœud ${node.label}`}</button>
      ))}
    </div>
  ),
}));

const A = '/projets/A';

const doc = (id: string, label: string, author: string, year: string): GraphNode => ({
  id,
  type: 'document',
  label,
  metadata: { title: label, author, year },
});

const CORPUS: GraphData = {
  nodes: [doc('a1', 'Ports baltes', 'Dupont', '1990'), doc('a2', 'Danzig libre', 'Martin', '2000')],
  edges: [{ source: 'a1', target: 'a2', type: 'similarity', weight: 0.8 }],
};

function installCorpus(graph: GraphData): void {
  const electron = (window as unknown as { electron: Record<string, unknown> }).electron;
  electron.config = { get: async () => ({}) };
  electron.corpus = {
    getStatistics: async () => ({
      success: true,
      statistics: {
        documentCount: graph.nodes.length,
        chunkCount: 10,
        citationCount: 0,
        totalCitationsExtracted: 0,
        languageCount: 1,
        languages: ['fr'],
        yearRange: null,
        authorCount: graph.nodes.length,
      },
    }),
    getGraph: async () => ({ success: true, graph: structuredClone(graph) }),
    loadTopics: async () => ({ success: false, error: 'No saved topic analysis found' }),
    getTopicTimeline: async () => ({ success: false }),
  };
}

function filter(label: string): HTMLSelectElement {
  const found = screen.getByText(label).parentElement?.querySelector('select');
  if (!found) throw new Error(`pas de filtre ${label}`);
  return found;
}

async function choose(label: string, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(filter(label), { target: { value } });
  });
}

async function openExplorer(): Promise<void> {
  await act(async () => {
    render(<CorpusExplorerPanel />);
  });
  await screen.findByText('nœud Ports baltes');
  await act(async () => {
    fireEvent.click(screen.getByText('corpus.filters'));
  });
}

beforeEach(() => {
  projectLifecycle.enter(A);
  useProjectStore.setState({
    currentProject: { id: A, name: A, path: A, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
  });
});

afterEach(() => {
  cleanup();
  projectLifecycle.enter(null);
  useProjectStore.setState({ currentProject: null });
});

describe('explorateur de corpus : filtres sans document et corpus vide (S18-1-6)', () => {
  it('Année 2000 + Dupont, sans intersection : les filtres restent, et le message le dit', async () => {
    installCorpus(CORPUS);
    await openExplorer();

    await choose('corpus.year', '2000');
    await choose('corpus.author', 'Dupont');

    expect(screen.queryByText('corpus.emptyCorpus')).toBeNull();
    expect(filter('corpus.year').value).toBe('2000');
    expect(filter('corpus.author').value).toBe('Dupont');
    const notice = screen.getByText('corpus.noDocumentMatchesFilters').parentElement as HTMLElement;
    expect(screen.queryByText(/^nœud /)).toBeNull();

    // Le bouton du message défait les filtres : tout le corpus revient.
    await act(async () => {
      fireEvent.click(within(notice).getByRole('button', { name: 'corpus.resetFilters' }));
    });
    expect(screen.getByText('nœud Ports baltes')).toBeInTheDocument();
    expect(screen.getByText('nœud Danzig libre')).toBeInTheDocument();
    expect(filter('corpus.year').value).toBe('');
    expect(screen.queryByText('corpus.noDocumentMatchesFilters')).toBeNull();
  });

  it('un filtre qui garde des documents : pas de message', async () => {
    installCorpus(CORPUS);
    await openExplorer();

    await choose('corpus.year', '2000');

    expect(screen.getByText('nœud Danzig libre')).toBeInTheDocument();
    expect(screen.queryByText('nœud Ports baltes')).toBeNull();
    expect(screen.queryByText('corpus.noDocumentMatchesFilters')).toBeNull();
  });

  it('un corpus réellement vide : « Corpus vide », sans filtres', async () => {
    installCorpus({ nodes: [], edges: [] });
    await act(async () => {
      render(<CorpusExplorerPanel />);
    });

    expect(await screen.findByText('corpus.emptyCorpus')).toBeInTheDocument();
    expect(screen.getByText('corpus.indexDocuments')).toBeInTheDocument();
    expect(screen.queryByText('corpus.filters')).toBeNull();
    expect(screen.queryByText('corpus.noDocumentMatchesFilters')).toBeNull();
  });
});
