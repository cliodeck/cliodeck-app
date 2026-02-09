import type { DocumentPage, DocumentChunk } from '../../types/pdf-document';
import { type ChunkingConfig } from './DocumentChunker';
/**
 * Adaptive Chunker using structure-aware splitting
 *
 * Instead of fixed-size chunks, this chunker:
 * 1. Detects document structure (sections, subsections)
 * 2. Keeps semantically related content together
 * 3. Respects natural boundaries (paragraphs, sections)
 *
 * Benefits:
 * - Better semantic coherence within chunks
 * - More meaningful context for RAG
 * - Improved retrieval accuracy (+10-15%)
 *
 * Performance: Pure regex-based, no ML overhead
 * Memory: Same as standard chunker
 */
export declare class AdaptiveChunker {
    private config;
    constructor(config?: ChunkingConfig);
    /**
     * Create chunks using adaptive structure-aware strategy
     */
    createChunks(pages: DocumentPage[], documentId: string, documentMeta?: {
        title?: string;
        abstract?: string;
    }): DocumentChunk[];
    /**
     * Detect document sections using common academic patterns
     */
    private detectSections;
    /**
     * Match section headers using regex patterns
     */
    private matchSectionHeader;
    /**
     * Classify section type (intro, method, results, etc.)
     */
    private classifySectionType;
    /**
     * Chunk a single section
     */
    private chunkSection;
    /**
     * Create page mapping for position lookup
     */
    private createPageMapping;
    /**
     * Find page number for a given position
     */
    private findPageNumber;
    /**
     * Split text into paragraphs while preserving lists and tables
     */
    private splitIntoParagraphs;
    /**
     * Detect structured content (lists, tables) to keep together
     */
    private detectStructuredContent;
    /**
     * Ensure chunk ends at a sentence boundary
     */
    private ensureSentenceBoundary;
    /**
     * Create smart overlap at sentence boundaries
     */
    private createSmartOverlap;
    /**
     * Add document context to chunk content
     */
    private enhanceChunkWithContext;
    /**
     * Clean chunk text
     */
    private cleanText;
    /**
     * Get chunking statistics (compatible with DocumentChunker)
     */
    getChunkingStats(chunks: any[]): {
        totalChunks: number;
        totalWords: number;
        averageWordCount: number;
        minWordCount: number;
        maxWordCount: number;
    };
}
