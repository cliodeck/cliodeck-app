import Graph from 'graphology';
import type { VectorStore } from '../vector-store/VectorStore';
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
    x?: number;
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
export declare class KnowledgeGraphBuilder {
    private vectorStore;
    constructor(vectorStore: VectorStore);
    /**
     * Calcule le degré d'un nœud (nombre d'arêtes connectées)
     */
    private getNodeDegree;
    /**
     * Construit le graphe de connaissances complet
     * @param options Options de construction du graphe
     * @returns Graphe graphology
     */
    buildGraph(options?: GraphBuildOptions): Promise<Graph>;
    /**
     * Ajoute les nœuds de documents au graphe
     */
    private addDocumentNodes;
    /**
     * Ajoute les arêtes de citations au graphe
     */
    private addCitationEdges;
    /**
     * Ajoute les arêtes de similarité sémantique au graphe
     */
    private addSimilarityEdges;
    /**
     * Ajoute les arêtes de co-citations au graphe
     * Deux documents sont co-cités s'ils sont cités ensemble par un même document
     */
    private addCoCitationEdges;
    /**
     * Ajoute les nœuds d'auteurs au graphe
     * Crée un nœud par auteur unique et des arêtes vers ses documents
     */
    private addAuthorNodes;
    /**
     * Calcule la centralité de chaque nœud (degré)
     * @param graph Graphe à analyser
     * @returns Map nœud -> centralité
     */
    calculateCentrality(graph: Graph): Map<string, number>;
    /**
     * Détecte les communautés dans le graphe (algorithme Louvain)
     * @param graph Graphe à analyser
     * @returns Map nœud -> communauté
     */
    detectCommunities(graph: Graph): Map<string, number>;
    /**
     * Calcule un layout force-directed pour visualisation
     * Utilise ForceAtlas2
     */
    private computeForceAtlas2Layout;
    /**
     * Exporte le graphe pour visualisation frontend
     * @param graph Graphe à exporter
     * @returns Structure JSON avec nœuds et arêtes
     */
    exportForVisualization(graph: Graph): {
        nodes: GraphNode[];
        edges: GraphEdge[];
    };
    /**
     * Calcule des statistiques sur le graphe
     * @param graph Graphe à analyser
     * @returns Statistiques
     */
    getStatistics(graph: Graph): GraphStatistics;
}
