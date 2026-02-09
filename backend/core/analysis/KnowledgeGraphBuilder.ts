import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import type { VectorStore } from '../vector-store/VectorStore';
import type { PDFDocument } from '../../types/pdf-document';

// MARK: - Types

export interface GraphNode {
  id: string;
  type: 'document' | 'author';
  label: string;
  metadata: {
    title?: string;
    author?: string;
    year?: string;
    summary?: string;
    language?: string;
    pageCount?: number;
    [key: string]: any;
  };
  centrality?: number;
  community?: number;
  x?: number; // Position pour visualisation
  y?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: 'citation' | 'similarity' | 'co-citation';
  weight: number;
  metadata?: {
    context?: string;
    pageNumber?: number;
    [key: string]: any;
  };
}

export interface GraphBuildOptions {
  includeSimilarityEdges?: boolean;
  similarityThreshold?: number;
  includeAuthorNodes?: boolean;
  computeLayout?: boolean;
}

export interface GraphStatistics {
  nodeCount: number;
  edgeCount: number;
  citationEdges: number;
  similarityEdges: number;
  coCitationEdges: number;
  averageDegree: number;
  communities: number;
  density: number;
}

/**
 * KnowledgeGraphBuilder construit un graphe de connaissances à partir des documents indexés
 * - Nœuds : documents (+ auteurs optionnel)
 * - Arêtes : citations directes, similarité sémantique, co-citations
 * - Calculs : centralité, détection de communautés
 * - Export : JSON pour visualisation frontend
 */
export class KnowledgeGraphBuilder {
  private vectorStore: VectorStore;

  constructor(vectorStore: VectorStore) {
    this.vectorStore = vectorStore;
  }

  // MARK: - Helper Methods

  /**
   * Calcule le degré d'un nœud (nombre d'arêtes connectées)
   */
  private getNodeDegree(graph: Graph, nodeId: string): number {
    return graph.inDegree(nodeId) + graph.outDegree(nodeId);
  }

  // MARK: - Graph Construction

  /**
   * Construit le graphe de connaissances complet
   * @param options Options de construction du graphe
   * @returns Graphe graphology
   */
  async buildGraph(options: GraphBuildOptions = {}): Promise<Graph> {
    const {
      includeSimilarityEdges = true,
      similarityThreshold = 0.7,
      includeAuthorNodes = false,
      computeLayout = true,
    } = options;

    console.log('📊 Building knowledge graph...');

    // Créer un graphe mixte (orienté pour citations, non-orienté pour similarité et co-citations)
    const graph = new Graph({ type: 'mixed', allowSelfLoops: false });

    // 1. Récupérer tous les documents
    const documents = this.vectorStore.getAllDocuments();
    console.log(`   Found ${documents.length} documents`);

    if (documents.length === 0) {
      console.warn('⚠️ No documents to build graph');
      return graph;
    }

    // 2. Ajouter les nœuds de documents
    this.addDocumentNodes(graph, documents);

    // 3. Ajouter les arêtes de citations
    await this.addCitationEdges(graph, documents);

    // 4. Ajouter les arêtes de similarité (optionnel)
    if (includeSimilarityEdges) {
      await this.addSimilarityEdges(graph, documents, similarityThreshold);
    }

    // 5. Ajouter les arêtes de co-citations
    this.addCoCitationEdges(graph);

    // 6. Ajouter les nœuds d'auteurs (optionnel)
    if (includeAuthorNodes) {
      this.addAuthorNodes(graph, documents);
    }

    // 7. Calculer le layout pour visualisation (optionnel)
    if (computeLayout) {
      this.computeForceAtlas2Layout(graph);
    }

    console.log('✅ Knowledge graph built successfully');
    console.log(`   Nodes: ${graph.order}, Edges: ${graph.size}`);

    return graph;
  }

  /**
   * Ajoute les nœuds de documents au graphe
   */
  private addDocumentNodes(graph: Graph, documents: PDFDocument[]): void {
    for (const doc of documents) {
      const node: GraphNode = {
        id: doc.id,
        type: 'document',
        label: doc.title,
        metadata: {
          title: doc.title,
          author: doc.author,
          year: doc.year,
          summary: (doc as any).summary,
          language: (doc as any).language,
          pageCount: doc.pageCount,
        },
      };

      graph.addNode(doc.id, node);
    }

    console.log(`   Added ${documents.length} document nodes`);
  }

  /**
   * Ajoute les arêtes de citations au graphe
   */
  private async addCitationEdges(graph: Graph, documents: PDFDocument[]): Promise<void> {
    let citationCount = 0;

    for (const doc of documents) {
      const citations = this.vectorStore.getCitationsForDocument(doc.id);

      for (const citation of citations) {
        // Ignorer les citations non matchées (targetDocId = null)
        if (!citation.targetDocId) {
          continue;
        }

        // Ignorer les auto-citations (self-loops)
        if (doc.id === citation.targetDocId) {
          continue;
        }

        // Vérifier que les deux nœuds existent
        if (!graph.hasNode(doc.id) || !graph.hasNode(citation.targetDocId)) {
          continue;
        }

        // Ajouter l'arête (source cite target)
        const edgeId = `citation_${citation.id}`;

        if (!graph.hasEdge(doc.id, citation.targetDocId)) {
          const edge: GraphEdge = {
            source: doc.id,
            target: citation.targetDocId,
            type: 'citation',
            weight: 1.0,
            metadata: {
              context: citation.context,
              pageNumber: citation.pageNumber,
            },
          };

          graph.addDirectedEdgeWithKey(edgeId, doc.id, citation.targetDocId, edge);
          citationCount++;
        }
      }
    }

    console.log(`   Added ${citationCount} citation edges`);
  }

  /**
   * Ajoute les arêtes de similarité sémantique au graphe
   */
  private async addSimilarityEdges(
    graph: Graph,
    documents: PDFDocument[],
    threshold: number
  ): Promise<void> {
    let similarityCount = 0;

    // Récupérer les similarités pré-calculées depuis la base
    for (const doc of documents) {
      const similar = this.vectorStore.getSimilarDocuments(doc.id, threshold, 10);

      for (const sim of similar) {
        // Ignorer les auto-similarités (self-loops)
        if (doc.id === sim.documentId) {
          continue;
        }

        // Vérifier que les deux nœuds existent
        if (!graph.hasNode(doc.id) || !graph.hasNode(sim.documentId)) {
          continue;
        }

        // Éviter les doublons (similarité est symétrique)
        if (graph.hasEdge(doc.id, sim.documentId) || graph.hasEdge(sim.documentId, doc.id)) {
          continue;
        }

        // Ajouter l'arête non-orientée de similarité
        const edgeId = `similarity_${doc.id}_${sim.documentId}`;

        const edge: GraphEdge = {
          source: doc.id,
          target: sim.documentId,
          type: 'similarity',
          weight: sim.similarity,
        };

        graph.addUndirectedEdgeWithKey(edgeId, doc.id, sim.documentId, edge);
        similarityCount++;
      }
    }

    console.log(`   Added ${similarityCount} similarity edges`);
  }

  /**
   * Ajoute les arêtes de co-citations au graphe
   * Deux documents sont co-cités s'ils sont cités ensemble par un même document
   */
  private addCoCitationEdges(graph: Graph): void {
    let coCitationCount = 0;

    // Pour chaque document source
    graph.forEachNode((sourceId) => {
      // Récupérer tous les documents qu'il cite
      const cited = graph.outNeighbors(sourceId);

      // Pour chaque paire de documents cités
      for (let i = 0; i < cited.length; i++) {
        for (let j = i + 1; j < cited.length; j++) {
          const doc1 = cited[i];
          const doc2 = cited[j];

          // Vérifier que les nœuds existent
          if (!graph.hasNode(doc1) || !graph.hasNode(doc2)) {
            continue;
          }

          // Vérifier qu'il n'y a pas déjà une arête
          const hasEdge = graph.hasEdge(doc1, doc2) || graph.hasEdge(doc2, doc1);

          if (!hasEdge) {
            const edgeId = `cocitation_${doc1}_${doc2}`;

            const edge: GraphEdge = {
              source: doc1,
              target: doc2,
              type: 'co-citation',
              weight: 0.5, // Poids plus faible que citation directe
            };

            graph.addUndirectedEdgeWithKey(edgeId, doc1, doc2, edge);
            coCitationCount++;
          }
        }
      }
    });

    console.log(`   Added ${coCitationCount} co-citation edges`);
  }

  /**
   * Ajoute les nœuds d'auteurs au graphe
   * Crée un nœud par auteur unique et des arêtes vers ses documents
   */
  private addAuthorNodes(graph: Graph, documents: PDFDocument[]): void {
    // Agréger les auteurs
    const authors = new Map<string, string[]>(); // auteur -> [docIds]

    for (const doc of documents) {
      if (doc.author) {
        const authorName = doc.author.trim();

        if (!authors.has(authorName)) {
          authors.set(authorName, []);
        }

        authors.get(authorName)!.push(doc.id);
      }
    }

    // Ajouter les nœuds d'auteurs
    let authorCount = 0;

    for (const [authorName, docIds] of authors.entries()) {
      const authorId = `author_${authorName.replace(/\s+/g, '_')}`;

      const node: GraphNode = {
        id: authorId,
        type: 'author',
        label: authorName,
        metadata: {
          documentCount: docIds.length,
        },
      };

      graph.addNode(authorId, node);

      // Ajouter les arêtes auteur -> documents
      for (const docId of docIds) {
        if (graph.hasNode(docId)) {
          const edgeId = `authorship_${authorId}_${docId}`;

          const edge: GraphEdge = {
            source: authorId,
            target: docId,
            type: 'citation', // Réutiliser le type citation
            weight: 1.0,
          };

          graph.addDirectedEdgeWithKey(edgeId, authorId, docId, edge);
        }
      }

      authorCount++;
    }

    console.log(`   Added ${authorCount} author nodes`);
  }

  // MARK: - Graph Computations

  /**
   * Calcule la centralité de chaque nœud (degré)
   * @param graph Graphe à analyser
   * @returns Map nœud -> centralité
   */
  calculateCentrality(graph: Graph): Map<string, number> {
    const centrality = new Map<string, number>();

    graph.forEachNode((nodeId) => {
      // Utiliser le degré total (in + out) comme mesure de centralité
      const nodeDegree = this.getNodeDegree(graph, nodeId);
      centrality.set(nodeId, nodeDegree);

      // Mettre à jour les attributs du nœud
      graph.setNodeAttribute(nodeId, 'centrality', nodeDegree);
    });

    console.log('✅ Centrality computed');

    return centrality;
  }

  /**
   * Détecte les communautés dans le graphe (algorithme Louvain)
   * @param graph Graphe à analyser
   * @returns Map nœud -> communauté
   */
  detectCommunities(graph: Graph): Map<string, number> {
    const communities = new Map<string, number>();

    // Louvain nécessite un graphe non-orienté
    // Créer une copie non-orientée temporaire
    const undirectedGraph = graph.copy();
    undirectedGraph.forEachEdge((edge, attributes, source, target) => {
      // Convertir toutes les arêtes en non-orientées
      if (graph.isDirected(edge)) {
        undirectedGraph.dropEdge(edge);

        if (!undirectedGraph.hasEdge(source, target)) {
          undirectedGraph.addUndirectedEdge(source, target, attributes);
        }
      }
    });

    // Appliquer l'algorithme Louvain
    const communityAssignments = louvain(undirectedGraph, {
      getEdgeWeight: 'weight', // Utiliser le poids des arêtes
    });

    // Stocker les résultats
    for (const [nodeId, community] of Object.entries(communityAssignments)) {
      communities.set(nodeId, community);

      // Mettre à jour les attributs du nœud dans le graphe original
      if (graph.hasNode(nodeId)) {
        graph.setNodeAttribute(nodeId, 'community', community);
      }
    }

    const uniqueCommunities = new Set(communities.values()).size;
    console.log(`✅ Communities detected: ${uniqueCommunities}`);

    return communities;
  }

  /**
   * Calcule un layout force-directed pour visualisation
   * Utilise ForceAtlas2
   */
  private computeForceAtlas2Layout(graph: Graph): void {
    // Initialiser avec des positions aléatoires
    graph.forEachNode((node) => {
      graph.setNodeAttribute(node, 'x', Math.random() * 1000);
      graph.setNodeAttribute(node, 'y', Math.random() * 1000);
    });

    // Appliquer ForceAtlas2
    const settings = forceAtlas2.inferSettings(graph);

    forceAtlas2.assign(graph, {
      iterations: 100, // Nombre d'itérations
      settings: {
        ...settings,
        scalingRatio: 10,
        gravity: 0.5,
        barnesHutOptimize: true,
      },
    });

    console.log('✅ Layout computed (ForceAtlas2)');
  }

  // MARK: - Export

  /**
   * Exporte le graphe pour visualisation frontend
   * @param graph Graphe à exporter
   * @returns Structure JSON avec nœuds et arêtes
   */
  exportForVisualization(graph: Graph): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // Exporter les nœuds
    graph.forEachNode((nodeId, attributes) => {
      nodes.push(attributes as GraphNode);
    });

    // Exporter les arêtes
    graph.forEachEdge((edgeId, attributes, source, target) => {
      edges.push(attributes as GraphEdge);
    });

    console.log(`📤 Exported ${nodes.length} nodes and ${edges.length} edges`);

    return { nodes, edges };
  }

  /**
   * Calcule des statistiques sur le graphe
   * @param graph Graphe à analyser
   * @returns Statistiques
   */
  getStatistics(graph: Graph): GraphStatistics {
    let citationEdges = 0;
    let similarityEdges = 0;
    let coCitationEdges = 0;

    graph.forEachEdge((edge, attributes) => {
      const edgeData = attributes as GraphEdge;

      switch (edgeData.type) {
        case 'citation':
          citationEdges++;
          break;
        case 'similarity':
          similarityEdges++;
          break;
        case 'co-citation':
          coCitationEdges++;
          break;
      }
    });

    // Calculer le degré moyen
    let totalDegree = 0;

    graph.forEachNode((node) => {
      totalDegree += this.getNodeDegree(graph, node);
    });

    const averageDegree = graph.order > 0 ? totalDegree / graph.order : 0;

    // Compter les communautés
    const communities = new Set<number>();

    graph.forEachNode((node, attributes) => {
      const nodeData = attributes as GraphNode;

      if (nodeData.community !== undefined) {
        communities.add(nodeData.community);
      }
    });

    // Calculer la densité du graphe
    const maxEdges = graph.order * (graph.order - 1);
    const density = maxEdges > 0 ? graph.size / maxEdges : 0;

    return {
      nodeCount: graph.order,
      edgeCount: graph.size,
      citationEdges,
      similarityEdges,
      coCitationEdges,
      averageDegree,
      communities: communities.size,
      density,
    };
  }
}
