import { Citation } from '../types/citation.js';
/**
 * Information about an orphan PDF file
 */
export interface OrphanPDFInfo {
    filePath: string;
    fileName: string;
    size: number;
    lastModified: Date;
}
/**
 * Result of orphan PDF detection scan
 */
export interface OrphanPDFScanResult {
    orphans: OrphanPDFInfo[];
    totalOrphans: number;
    totalSize: number;
    scannedFiles: number;
    linkedFiles: number;
}
/**
 * Options for orphan PDF detection
 */
export interface OrphanDetectionOptions {
    projectPath: string;
    citations: Citation[];
    includeSubdirectories?: boolean;
    pdfSubdirectory?: string;
}
/**
 * Service for detecting and managing orphan PDF files
 *
 * An orphan PDF is a PDF file in the project directory that is not linked
 * to any citation in the bibliography.
 */
export declare class OrphanPDFDetector {
    /**
     * Detect orphan PDFs in the project directory
     */
    detectOrphans(options: OrphanDetectionOptions): Promise<OrphanPDFScanResult>;
    /**
     * Delete orphan PDF files
     *
     * @param filePaths Array of absolute file paths to delete
     * @returns Result with success/failure counts
     */
    deleteOrphans(filePaths: string[]): Promise<{
        deleted: number;
        failed: {
            path: string;
            error: string;
        }[];
    }>;
    /**
     * Move orphan PDFs to a subdirectory (safer than deletion)
     *
     * @param filePaths Array of absolute file paths to move
     * @param projectPath Project root directory
     * @param archiveSubdir Subdirectory name for archived files (default: 'orphan_pdfs')
     * @returns Result with success/failure counts
     */
    archiveOrphans(filePaths: string[], projectPath: string, archiveSubdir?: string): Promise<{
        archived: number;
        failed: {
            path: string;
            error: string;
        }[];
        archivePath: string;
    }>;
    /**
     * Recursively scan directory for PDF files
     *
     * @param dirPath Directory to scan
     * @param recursive Whether to scan subdirectories
     * @returns Array of absolute PDF file paths
     */
    private scanForPDFs;
    /**
     * Format file size to human-readable string
     */
    static formatFileSize(bytes: number): string;
}
