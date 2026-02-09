export interface PDFMetadata {
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  creationDate?: Date;
  modificationDate?: Date;
  [key: string]: any;
}

export interface Citation {
  id: string;
  text: string; // ex: "Papert, 1980" ou "(Papert, 1980)"
  author?: string; // ex: "Papert"
  year?: string; // ex: "1980"
  context?: string; // Paragraphe contenant la citation
  pageNumber?: number;
}

export interface DocumentCitation {
  id: string;
  sourceDocId: string;
  targetCitation: string;
  targetDocId?: string;
  context?: string;
  pageNumber?: number;
}

export interface DocumentSimilarity {
  documentId: string;
  similarity: number;
}

export interface PDFDocument {
  id: string;
  fileURL: string;
  title: string;
  author?: string;
  year?: string;
  bibtexKey?: string;
  pageCount: number;
  metadata: PDFMetadata;
  createdAt: Date;
  indexedAt: Date;
  lastAccessedAt: Date;

  // Nouveaux champs enrichis
  summary?: string;
  summaryEmbedding?: Float32Array;
  citationsExtracted?: Citation[];
  language?: string;

  // Computed property pour affichage
  get displayString(): string;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  content: string;
  pageNumber: number;
  chunkIndex: number;
  startPosition: number;
  endPosition: number;
  metadata?: ChunkMetadata;
}

export interface ChunkMetadata {
  sectionTitle?: string;
  sectionType?: 'abstract' | 'introduction' | 'methodology' | 'results' | 'discussion' | 'conclusion' | 'references' | 'content';
  sectionLevel?: number;
}

export interface ChunkWithEmbedding {
  chunk: DocumentChunk;
  embedding: Float32Array;
}

export interface SearchResult {
  chunk: DocumentChunk;
  document: PDFDocument;
  similarity: number;
}

export interface VectorStoreStatistics {
  documentCount: number;
  chunkCount: number;
  embeddingCount: number;
  databasePath: string;
}

export interface DocumentPage {
  pageNumber: number;
  text: string;
}

export interface ZoteroCollectionInfo {
  key: string;
  name: string;
  parentKey?: string;
}
