/**
 * ContextCompressor - Intelligent chunk compression for RAG
 *
 * Implements multi-strategy compression:
 * 1. Semantic deduplication (remove similar chunks)
 * 2. Relevance-based sentence extraction (keep only relevant sentences)
 * 3. Hierarchical compression (adapt strategy based on size)
 * 4. Keyword preservation (always keep sentences with query terms)
 */
interface Chunk {
    content: string;
    documentId: string;
    documentTitle: string;
    pageNumber: number;
    similarity: number;
    embedding?: number[];
}
interface CompressedResult {
    chunks: Chunk[];
    stats: {
        originalSize: number;
        compressedSize: number;
        originalChunks: number;
        compressedChunks: number;
        reductionPercent: number;
        strategy: string;
    };
}
export declare class ContextCompressor {
    /**
     * Main compression method - applies strategies based on content size
     */
    compress(chunks: Chunk[], query: string, maxChars?: number): CompressedResult;
    /**
     * Calculate total character count of all chunks
     */
    private calculateTotalSize;
    /**
     * Extract important keywords from query (for preservation during compression)
     */
    private extractKeywords;
    /**
     * Semantic deduplication - Remove chunks that are too similar to each other
     */
    private deduplicateSemanticChunks;
    /**
     * Calculate text similarity using Jaccard similarity on word sets
     * (Faster than cosine similarity, good enough for deduplication)
     */
    private calculateTextSimilarity;
    /**
     * Extract only the most relevant sentences from each chunk
     */
    private extractRelevantSentences;
    /**
     * Split text into sentences (handles common abbreviations)
     */
    private splitIntoSentences;
    /**
     * Select top-K chunks by similarity score
     */
    private selectTopKChunks;
}
export {};
