import type { Citation } from '../../types/citation';
/**
 * BibTeX Exporter
 *
 * Exports citations to BibTeX format, preserving all metadata including
 * custom fields, tags, keywords, and notes.
 */
export declare class BibTeXExporter {
    /**
     * Export citations to BibTeX file
     */
    exportToFile(citations: Citation[], filePath: string): Promise<void>;
    /**
     * Export citations to BibTeX string
     */
    exportToString(citations: Citation[]): string;
    /**
     * Convert a single citation to BibTeX entry
     */
    private citationToBibTeX;
    /**
     * Format a BibTeX field with proper escaping
     */
    private formatField;
    /**
     * Escape special LaTeX characters in value
     */
    private escapeValue;
    /**
     * Check if value needs braces (always use braces for safety)
     */
    private needsBraces;
    /**
     * Convert Unicode characters to LaTeX commands (optional, for maximum compatibility)
     */
    private unicodeToLatex;
    /**
     * Export citations with LaTeX-compatible encoding (converts Unicode to LaTeX commands)
     */
    exportToStringLegacy(citations: Citation[]): string;
    /**
     * Convert citation to BibTeX with Unicode → LaTeX conversion
     */
    private citationToBibTeXLegacy;
    /**
     * Format field with Unicode → LaTeX conversion
     */
    private formatFieldLegacy;
}
