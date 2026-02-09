export type Granularity = 'section' | 'paragraph' | 'sentence';
export type SourceType = 'secondary' | 'primary' | 'both';
export interface SimilarityOptions {
    granularity: Granularity;
    maxResults: number;
    similarityThreshold: number;
    collectionFilter: string[] | null;
    useReranking: boolean;
    useContextualEmbedding: boolean;
    sourceType: SourceType;
}
export interface TextSegment {
    id: string;
    content: string;
    startLine: number;
    endLine: number;
    type: Granularity;
    title?: string;
}
export interface PDFRecommendation {
    pdfId: string;
    title: string;
    authors: string[];
    similarity: number;
    chunkPreview: string;
    zoteroKey?: string;
    pageNumber?: number;
    sourceType?: 'secondary' | 'primary';
    sourceId?: string;
    archive?: string;
    collection?: string;
    date?: string;
    tags?: string[];
}
export interface SimilarityResult {
    segmentId: string;
    segment: TextSegment;
    recommendations: PDFRecommendation[];
    analyzedAt: number;
}
export interface SimilarityCache {
    documentHash: string;
    vectorStoreHash: string;
    segments: Record<string, SimilarityResult>;
    createdAt: number;
    options: SimilarityOptions;
}
export interface AnalysisProgress {
    current: number;
    total: number;
    status: string;
    percentage: number;
    currentSegment?: string;
}
declare class SimilarityService {
    private abortController;
    /**
     * Analyze a document and find similar PDFs for each segment
     */
    analyzeDocument(text: string, options?: Partial<SimilarityOptions>, onProgress?: (progress: AnalysisProgress) => void): Promise<SimilarityResult[]>;
    /**
     * Cancel ongoing analysis
     */
    cancelAnalysis(): void;
    /**
     * Extract document-level context (title from first H1)
     */
    private extractDocumentContext;
    /**
     * Build a map of line numbers to their containing section title
     * Used for contextual embeddings to know which section a paragraph belongs to
     */
    private buildSectionMap;
    /**
     * Build a contextual query by adding document context
     * This helps the embedding model understand the broader topic
     */
    private buildContextualQuery;
    /**
     * Segment text based on granularity
     */
    segmentText(text: string, granularity: Granularity): TextSegment[];
    /**
     * Segment by Markdown headings (#, ##, ###, etc.)
     */
    private segmentBySection;
    /**
     * Segment by paragraphs (separated by blank lines)
     */
    private segmentByParagraph;
    /**
     * Segment by sentences
     * Handles common abbreviations in French and English
     */
    private segmentBySentence;
    /**
     * Find similar PDFs for a given segment
     */
    private findSimilarPDFs;
    /**
     * Rerank recommendations using LLM listwise comparison
     *
     * Asks the LLM to rank all candidates at once, which is more efficient
     * and often more accurate than pairwise or pointwise scoring.
     */
    private rerankWithLLM;
    /**
     * Parse the LLM's ranking response into an array of indices
     */
    private parseRankingResponse;
    private getCachePath;
    loadCache(projectPath: string): Promise<SimilarityCache | null>;
    saveCache(projectPath: string, cache: SimilarityCache): Promise<void>;
    clearCache(projectPath?: string): Promise<void>;
    private isCacheValid;
    private computeHash;
    private computeVectorStoreHash;
    /**
     * Get results for a specific segment from cache
     */
    getResultsForSegment(segmentId: string): Promise<SimilarityResult | null>;
    /**
     * Get all cached results
     */
    getAllCachedResults(): Promise<SimilarityResult[]>;
}
export declare const similarityService: SimilarityService;
export {};
