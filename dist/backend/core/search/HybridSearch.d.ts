import { HNSWVectorStore } from '../vector-store/HNSWVectorStore';
import { BM25Index } from './BM25Index';
import type { SearchResult } from '../../types/pdf-document';
/**
 * Hybrid Search combining dense (HNSW) and sparse (BM25) retrieval
 *
 * Strategy:
 * 1. Dense retrieval (HNSW): Semantic similarity via embeddings
 * 2. Sparse retrieval (BM25): Keyword matching via term frequencies
 * 3. Fusion: Reciprocal Rank Fusion (RRF) to combine results
 *
 * Performance:
 * - Dense search: 10-20ms for 50k chunks
 * - Sparse search: 5-10ms for 50k chunks
 * - Total: ~30ms (vs 500ms linear search)
 *
 * Accuracy:
 * - Dense alone: Good for semantic/paraphrase queries
 * - Sparse alone: Good for exact keywords/technical terms
 * - Hybrid: Best of both worlds (+15-20% precision)
 */
export declare class HybridSearch {
    private hnswStore;
    private bm25Index;
    private readonly K;
    private denseWeight;
    private sparseWeight;
    constructor();
    /**
     * Set the HNSW vector store
     */
    setHNSWStore(store: HNSWVectorStore): void;
    /**
     * Set the BM25 index
     */
    setBM25Index(index: BM25Index): void;
    /**
     * Hybrid search combining dense and sparse retrieval
     */
    search(query: string, queryEmbedding: Float32Array, k?: number, documentIds?: string[], useHybrid?: boolean): Promise<SearchResult[]>;
    /**
     * Reciprocal Rank Fusion (RRF) with exact match boosting
     *
     * Formula: RRF(d) = Σ (1 / (k + rank_i(d)))
     * where rank_i(d) is the rank of document d in retrieval system i
     *
     * RRF is parameter-free and has been shown to outperform other fusion methods
     * in many cases. It's especially good when the retrieval systems have
     * different score scales (like cosine similarity vs BM25 scores).
     *
     * Exact match boosting: chunks containing exact query keywords get a 2x boost
     * to prioritize precise keyword matches (important for proper nouns, technical terms)
     */
    private reciprocalRankFusion;
    /**
     * Set fusion weights (must sum to 1.0)
     */
    setWeights(denseWeight: number, sparseWeight: number): void;
    /**
     * Get current configuration
     */
    getConfig(): {
        K: number;
        denseWeight: number;
        sparseWeight: number;
    };
}
