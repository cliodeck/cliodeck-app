import type { SearchResult, DocumentChunk } from '../../types/pdf-document';
export interface HNSWInitResult {
    success: boolean;
    loaded: boolean;
    corrupted: boolean;
    error?: string;
}
/**
 * HNSW-based vector store for fast approximate nearest neighbor search
 *
 * Performance characteristics:
 * - Memory: ~500 MB for 50k chunks (768-dim vectors)
 * - Search time: O(log n) - typically 10-20ms for 50k chunks
 * - Index build time: O(n log n) - about 1-2s per 1000 chunks
 *
 * Configuration:
 * - M=16: Number of bi-directional links per node (trade-off: memory vs accuracy)
 * - efConstruction=100: Size of dynamic candidate list during construction
 * - efSearch=50: Size of dynamic candidate list during search (configurable)
 */
export declare class HNSWVectorStore {
    private index;
    private dimension;
    private maxElements;
    private indexPath;
    private chunkIdMap;
    private chunkDataMap;
    private isInitialized;
    private currentSize;
    private wasCorrupted;
    private readonly M;
    private readonly efConstruction;
    private efSearch;
    constructor(projectPath: string, dimension?: number, maxElements?: number);
    /**
     * Check if an index file appears to be valid (basic integrity check)
     * This helps prevent SIGSEGV crashes from corrupted files
     */
    private validateIndexFile;
    /**
     * Check if the index was detected as corrupted during initialization
     */
    wasIndexCorrupted(): boolean;
    /**
     * Initialize or load existing HNSW index
     * Returns detailed result for caller to handle recovery if needed
     */
    initialize(): Promise<HNSWInitResult>;
    /**
     * Add a chunk with its embedding to the index
     */
    addChunk(chunk: DocumentChunk, embedding: Float32Array): Promise<void>;
    /**
     * Batch add chunks (more efficient than adding one by one)
     */
    addChunks(chunks: Array<{
        chunk: DocumentChunk;
        embedding: Float32Array;
    }>): Promise<void>;
    /**
     * Search for nearest neighbors
     */
    search(queryEmbedding: Float32Array, k?: number, documentIds?: string[]): Promise<SearchResult[]>;
    /**
     * Save index to disk with atomic write (write to temp, then rename)
     */
    save(): Promise<void>;
    /**
     * Load metadata from disk with validation
     * Returns true if metadata was loaded successfully, false otherwise
     */
    loadMetadata(): Promise<boolean>;
    /**
     * Clear all data
     */
    clear(): Promise<void>;
    /**
     * Get statistics
     */
    getStats(): {
        dimension: number;
        currentSize: number;
        maxElements: number;
        M: number;
        efConstruction: number;
        efSearch: number;
    };
    /**
     * Set search accuracy (higher = more accurate but slower)
     */
    setSearchAccuracy(ef: number): void;
    /**
     * Check if chunk exists in index
     */
    hasChunk(chunkId: string): boolean;
    /**
     * Get total number of chunks
     */
    getSize(): number;
}
