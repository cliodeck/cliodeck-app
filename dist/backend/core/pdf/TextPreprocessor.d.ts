/**
 * TextPreprocessor - Clean and normalize text before chunking
 *
 * Features:
 * - OCR artifact cleanup (invalid characters, split words)
 * - Header/footer detection and removal
 * - Page number removal
 * - Whitespace normalization
 */
import type { DocumentPage } from '../../types/pdf-document.js';
export interface PreprocessingConfig {
    enableOCRCleanup: boolean;
    enableHeaderFooterRemoval: boolean;
    enablePageNumberRemoval: boolean;
    headerFooterThreshold: number;
}
export interface PreprocessingStats {
    headersRemoved: number;
    footersRemoved: number;
    pageNumbersRemoved: number;
    charactersRemoved: number;
    originalLength: number;
    processedLength: number;
}
export declare class TextPreprocessor {
    private config;
    constructor(config?: Partial<PreprocessingConfig>);
    /**
     * Run full preprocessing pipeline on pages
     */
    preprocess(pages: DocumentPage[], options?: Partial<PreprocessingConfig>): {
        pages: DocumentPage[];
        stats: PreprocessingStats;
    };
    /**
     * Clean OCR artifacts from text
     */
    cleanOCRArtifacts(text: string): string;
    /**
     * Remove page numbers from text
     */
    removePageNumbers(text: string): string;
    /**
     * Detect and remove repeated headers/footers
     */
    removeHeadersFooters(pages: DocumentPage[], threshold?: number): {
        pages: DocumentPage[];
        headersRemoved: number;
        footersRemoved: number;
    };
    /**
     * Normalize a line for comparison (case-insensitive, ignore page numbers)
     */
    private normalizeLineForComparison;
    /**
     * Count occurrences of each string
     */
    private countOccurrences;
    /**
     * Simple cleanup without full preprocessing
     */
    quickClean(text: string): string;
}
