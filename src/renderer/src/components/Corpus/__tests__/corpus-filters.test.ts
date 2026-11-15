/**
 * Les filtres de l'explorateur gardent les liens entre les documents retenus (S13-2-1).
 *
 * Le graphe affiché reçoit les mêmes objets arêtes que le graphe complet, et d3-force y remplace en
 * place `source` et `target` (des identifiants) par les nœuds eux-mêmes. Le filtre cherchait ensuite
 * ces objets dans un ensemble d'identifiants : tout filtre, et même « Réinitialiser filtres »,
 * laissait un graphe sans aucun lien jusqu'à « Régénérer le graphe ».
 *
 * Les arêtes passent ici par le vrai `forceLink` de d3-force-3d, celui de force-graph, comme à
 * chaque affichage du graphe.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error d3-force-3d ne publie pas de types ; c'est le paquet que force-graph emploie.
import { forceLink as untypedForceLink } from 'd3-force-3d';
import { edgeEndpointId, filterCorpusGraph } from '../corpus-filters';
import type { CorpusFilters, GraphData, GraphEdge, GraphNode } from '../corpus-types';

const forceLink = untypedForceLink as (links: GraphEdge[]) => {
  id(accessor: (node: GraphNode) => string): { initialize(nodes: GraphNode[]): void };
};

const NO_FILTER: CorpusFilters = { year: null, author: null, language: null, topic: null };

const doc = (id: string, year: string, author = 'Dupont'): GraphNode => ({
  id,
  type: 'document',
  label: id,
  metadata: { title: id, author, year },
});

const similarity = (source: string, target: string): GraphEdge => ({ source, target, type: 'similarity', weight: 0.8 });

/** Le graphe que le main envoie : trois documents, un lien par paire. */
function corpus(): GraphData {
  return {
    nodes: [doc('a', '1990'), doc('b', '1990', 'Martin'), doc('c', '2000')],
    edges: [similarity('a', 'b'), similarity('b', 'c'), similarity('a', 'c')],
  };
}

/** Ce que force-graph fait des arêtes à l'affichage : `forceLink.id(...).links(...)` sur ses nœuds. */
function displayed(graph: GraphData): GraphData {
  forceLink(graph.edges)
    .id((node) => node.id)
    .initialize(graph.nodes);
  return graph;
}

const ends = (graph: GraphData): string[] =>
  graph.edges.map((edge) => `${edgeEndpointId(edge.source)}-${edgeEndpointId(edge.target)}`);

describe('filterCorpusGraph : les liens d’un graphe déjà affiché', () => {
  it('le témoin : d3-force remplace bien les identifiants par les nœuds', () => {
    const graph = displayed(corpus());

    expect(typeof graph.edges[0].source).toBe('object');
    expect(graph.edges[0].source).toBe(graph.nodes[0]);
  });

  it('filtre Année : le lien entre les deux documents de 1990 reste', () => {
    const filtered = filterCorpusGraph(displayed(corpus()), { ...NO_FILTER, year: 1990 });

    expect(filtered.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(ends(filtered)).toEqual(['a-b']);
  });

  it('filtre Auteur : les liens entre les documents de l’auteur restent', () => {
    const filtered = filterCorpusGraph(displayed(corpus()), { ...NO_FILTER, author: 'Dupont' });

    expect(ends(filtered)).toEqual(['a-c']);
  });

  it('sans filtre (« Réinitialiser ») : tous les liens reviennent', () => {
    const graph = displayed(corpus());
    filterCorpusGraph(graph, { ...NO_FILTER, year: 1990 });

    expect(ends(filterCorpusGraph(graph, NO_FILTER))).toEqual(['a-b', 'b-c', 'a-c']);
  });

  it('un graphe pas encore affiché (identifiants en chaînes) se filtre de même', () => {
    expect(ends(filterCorpusGraph(corpus(), { ...NO_FILTER, year: 1990 }))).toEqual(['a-b']);
  });

  it('réaffiché filtré, puis réinitialisé : d3 reprend les nœuds déjà posés, et les liens reviennent', () => {
    const graph = displayed(corpus());
    displayed(filterCorpusGraph(graph, { ...NO_FILTER, year: 1990 }));

    expect(ends(displayed(filterCorpusGraph(graph, NO_FILTER)))).toEqual(['a-b', 'b-c', 'a-c']);
  });
});

describe('filterCorpusGraph : les nœuds retenus', () => {
  it('l’année se compare au texte de la notice : « 1990 » répond à 1990, « 1990-05 » non', () => {
    const graph: GraphData = { nodes: [doc('a', '1990'), doc('b', '1990-05'), doc('c', '')], edges: [] };

    expect(filterCorpusGraph(graph, { ...NO_FILTER, year: 1990 }).nodes.map((node) => node.id)).toEqual(['a']);
  });

  it('filtre Thème : les documents affectés à ce thème, et les liens entre eux', () => {
    const filtered = filterCorpusGraph(displayed(corpus()), { ...NO_FILTER, topic: 3 }, { a: 3, b: 4, c: 3 });

    expect(filtered.nodes.map((node) => node.id)).toEqual(['a', 'c']);
    expect(ends(filtered)).toEqual(['a-c']);
  });

  it('filtre Thème sans analyse : rien n’est écarté', () => {
    expect(filterCorpusGraph(corpus(), { ...NO_FILTER, topic: 3 }).nodes).toHaveLength(3);
  });
});

describe('edgeEndpointId', () => {
  it('rend l’identifiant, que l’extrémité soit encore une chaîne ou déjà un nœud', () => {
    expect(edgeEndpointId('a')).toBe('a');
    expect(edgeEndpointId(doc('a', '1990'))).toBe('a');
  });
});
