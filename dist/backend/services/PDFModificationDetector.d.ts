import type { Citation } from '../types/citation';
/**
 * Information about a modified PDF
 */
export interface ModifiedPDFInfo {
    citationId: string;
    citationTitle: string;
    filePath: string;
    reason: 'md5-changed' | 'file-modified' | 'file-missing';
    oldMD5?: string;
    newMD5?: string;
}
/**
 * Result of PDF modification detection
 */
export interface PDFModificationResult {
    modifiedPDFs: ModifiedPDFInfo[];
    totalChecked: number;
    totalModified: number;
}
/**
 * Service for detecting modified PDFs by comparing MD5 hashes
 *
 * Detects when local PDFs have been modified compared to their stored MD5 hashes.
 * This helps keep the RAG index up-to-date with the latest PDF content.
 */
export declare class PDFModificationDetector {
    /**
     * Check for modified PDFs in citations
     *
     * @param citations List of citations to check
     * @returns List of modified PDFs with details
     */
    detectModifiedPDFs(citations: Citation[]): Promise<PDFModificationResult>;
    /**
     * Get stored MD5 hash from citation's Zotero attachments
     */
    private getStoredMD5;
    /**
     * Calculate MD5 hash of a file
     */
    private calculateMD5;
    /**
     * Calculate MD5 hash of a file (streaming for large files)
     */
    private calculateMD5Stream;
    /**
     * Update citation with new MD5 hash after re-indexation
     *
     * This would typically be called after successfully re-indexing a modified PDF
     * to update the stored MD5 hash to match the current file.
     */
    updateMD5Hash(citation: Citation, filePath: string): Promise<string>;
}
