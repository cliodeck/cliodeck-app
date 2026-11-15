import type { CorpusFilters, GraphData } from './corpus-types';

/**
 * L'identifiant d'une extrémité d'arête. Une fois le graphe affiché, d3-force a remplacé en place
 * `source` et `target` (des identifiants) par les nœuds eux-mêmes, dans les arêtes du graphe complet
 * aussi : les deux formes se lisent ici, et nulle part ailleurs.
 */
export function edgeEndpointId(endpoint: string | { id: string }): string {
  return typeof endpoint === 'object' ? endpoint.id : endpoint;
}

/**
 * Le graphe de l'explorateur réduit aux filtres : les nœuds retenus, et les arêtes entre eux.
 *
 * Le filtre « Langue » est reçu mais ne filtre encore rien (S13-2-5) : sa condition viendra ici.
 */
export function filterCorpusGraph(
  full: GraphData,
  filters: CorpusFilters,
  topicAssignments?: Record<string, number>
): GraphData {
  let filteredNodes = [...full.nodes];

  if (filters.year !== null) {
    // L'année de la notice, comparée en texte : « 1990-05 » ne répond pas à 1990.
    filteredNodes = filteredNodes.filter(
      (node) => node.metadata?.year === filters.year?.toString()
    );
  }
  if (filters.author !== null) {
    filteredNodes = filteredNodes.filter(
      (node) => node.metadata?.author === filters.author
    );
  }
  if (filters.topic !== null && topicAssignments) {
    const docsInTopic = Object.entries(topicAssignments)
      .filter(([, topicId]) => topicId === filters.topic)
      .map(([docId]) => docId);
    filteredNodes = filteredNodes.filter((node) => docsInTopic.includes(node.id));
  }

  const nodeIds = new Set(filteredNodes.map((n) => n.id));
  const filteredEdges = full.edges.filter(
    (edge) => nodeIds.has(edgeEndpointId(edge.source)) && nodeIds.has(edgeEndpointId(edge.target))
  );

  return { nodes: filteredNodes, edges: filteredEdges };
}
