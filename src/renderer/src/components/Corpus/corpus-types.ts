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
  source: string;
  target: string;
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
