export interface GraphNode {
  id: string;
  type: 'document' | 'author';
  label: string;
  metadata?: {
    title?: string;
    author?: string;
    year?: string;
    pageCount?: number;
  };
  centrality?: number;
  community?: number;
  x?: number;
  y?: number;
}

export interface GraphEdge {
  // Des identifiants à la réception ; d3-force les remplace en place par les nœuds dès que le graphe
  // s'affiche. Lire par `edgeEndpointId` (corpus-filters.ts).
  source: string | GraphNode;
  target: string | GraphNode;
  type: 'citation' | 'similarity' | 'co-citation';
  weight: number;
  metadata?: {
    context?: string;
    pageNumber?: number;
  };
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Les filtres de l'explorateur ; `null` : pas de filtre. */
export interface CorpusFilters {
  year: number | null;
  author: string | null;
  language: string | null;
  topic: number | null;
}

export interface CorpusStatistics {
  documentCount: number;
  chunkCount: number;
  citationCount: number;
  totalCitationsExtracted: number;
  languageCount: number;
  languages: string[];
  yearRange: {
    min: number;
    max: number;
  } | null;
  authorCount: number;
}

export interface Topic {
  id: number;
  keywords: string[];
  size: number;
  representative_docs?: string[];
}

export interface TopicAnalysisResult {
  topics: Topic[];
  topicAssignments?: Record<string, number>;
  outliers?: string[];
  statistics?: {
    totalDocuments: number;
    numTopics: number;
    numOutliers: number;
    numDocumentsInTopics: number;
  };
  options?: {
    minTopicSize?: number;
    nrTopics?: number | 'auto';
    language?: string;
    nGramRange?: [number, number];
  };
}
