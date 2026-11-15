// @vitest-environment jsdom
/**
 * Cliquer un nœud ne relance plus la simulation du graphe.
 *
 * force-graph relance sa simulation (`stop().alpha(1)`) chaque fois que sa prop `graphData` change
 * d'identité. La section la recréait à chaque rendu : un clic sur un nœud, qui affiche ses détails,
 * faisait repartir tout le graphe.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CorpusGraphSection } from '../CorpusGraphSection';
import type { GraphData, GraphNode } from '../corpus-types';

const received: unknown[] = [];

vi.mock('react-force-graph-2d', () => ({
  default: ({ graphData }: { graphData: unknown }) => {
    received.push(graphData);
    return null;
  },
}));

afterEach(() => {
  cleanup();
  received.length = 0;
});

const doc = (id: string): GraphNode => ({ id, type: 'document', label: id, metadata: { title: id, year: '1990' } });

const GRAPH: GraphData = {
  nodes: [doc('a'), doc('b')],
  edges: [{ source: 'a', target: 'b', type: 'similarity', weight: 0.8 }],
};

function section(graphData: GraphData, selectedNode: GraphNode | null) {
  return (
    <CorpusGraphSection
      graphData={graphData}
      graphRef={{ current: undefined }}
      selectedNode={selectedNode}
      setSelectedNode={() => undefined}
      graphSimilarityThreshold={0.7}
      setGraphSimilarityThreshold={() => undefined}
      includeAuthorNodes={false}
      setIncludeAuthorNodes={() => undefined}
      regeneratingGraph={false}
      onRegenerateGraph={() => undefined}
      onExportGEXF={() => undefined}
    />
  );
}

describe('CorpusGraphSection : les données du graphe', () => {
  it('un nœud sélectionné : force-graph reçoit le même objet, et ne repart pas', () => {
    const { rerender } = render(section(GRAPH, null));
    rerender(section(GRAPH, GRAPH.nodes[0]));
    rerender(section(GRAPH, null));

    expect(received).toHaveLength(3);
    expect(received[1]).toBe(received[0]);
    expect(received[2]).toBe(received[0]);
  });

  it('un autre graphe (filtre, régénération) : force-graph reçoit ses nœuds et ses liens', () => {
    const { rerender } = render(section(GRAPH, null));
    const filtered: GraphData = { nodes: [GRAPH.nodes[0]], edges: [] };
    rerender(section(filtered, null));

    expect(received[1]).not.toBe(received[0]);
    expect(received[1]).toEqual({ nodes: filtered.nodes, links: filtered.edges });
  });
});
