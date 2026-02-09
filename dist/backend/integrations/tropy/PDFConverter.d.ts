/**
 * PDFConverter - Convert PDF pages to images using Poppler
 *
 * Directly uses system-installed Poppler utilities (pdftoppm/pdftocairo).
 * Requires Poppler to be installed on the system:
 * - macOS: brew install poppler
 * - Ubuntu: apt-get install poppler-utils
 * - Windows: Download from https://github.com/oschwartz10612/poppler-windows
 */
export interface PDFPageImage {
    pageNumber: number;
    width: number;
    height: number;
    data: Buffer;
}
export interface PDFConversionOptions {
    /** Scale factor for rendering (default: 2.0 for good OCR quality) */
    scale?: number;
    /** Specific pages to convert (1-indexed), or undefined for all pages */
    pages?: number[];
    /** Output format (default: 'png') */
    format?: 'png';
    /** DPI for rendering (default: 300 for good OCR quality) */
    dpi?: number;
}
export interface PDFConversionResult {
    pageCount: number;
    pages: PDFPageImage[];
    tempDir?: string;
}
export declare class PDFConverter {
    private pdftoppmPath;
    private pdftocairoPath;
    private pdfinfoPath;
    private isInitialized;
    /**
     * Find Poppler binary in common locations
     */
    private findBinary;
    /**
     * Initialize - find Poppler binaries
     */
    initialize(): Promise<void>;
    /**
     * Check if a file is a PDF
     */
    isPDF(filePath: string): boolean;
    /**
     * Get the number of pages in a PDF
     */
    getPageCount(pdfPath: string): Promise<number>;
    /**
     * Convert PDF pages to images
     * Returns image buffers that can be used for OCR
     */
    convertToImages(pdfPath: string, options?: PDFConversionOptions): Promise<PDFConversionResult>;
    /**
     * Convert PDF to temporary image files using system Poppler
     */
    convertToTempFiles(pdfPath: string, options?: PDFConversionOptions): Promise<{
        tempDir: string;
        files: string[];
        pageCount: number;
    }>;
    /**
     * Clean up temporary files
     */
    cleanupTempFiles(tempDir: string): void;
}
export declare function createPDFConverter(): PDFConverter;
