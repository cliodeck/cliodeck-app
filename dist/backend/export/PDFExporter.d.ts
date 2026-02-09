export interface PDFExportOptions {
    format?: 'A4' | 'Letter';
    margin?: {
        top?: string;
        right?: string;
        bottom?: string;
        left?: string;
    };
    headerTemplate?: string;
    footerTemplate?: string;
    displayHeaderFooter?: boolean;
    printBackground?: boolean;
    landscape?: boolean;
}
export declare class PDFExporter {
    /**
     * Exporte du markdown en PDF
     */
    exportToPDF(markdown: string, outputPath: string, options?: PDFExportOptions): Promise<void>;
    /**
     * Convertit markdown en HTML avec style académique
     */
    private markdownToHTML;
    /**
     * Styles CSS académiques
     */
    private getAcademicStyles;
    /**
     * Template de header par défaut
     */
    private defaultHeaderTemplate;
    /**
     * Template de footer par défaut (numéro de page)
     */
    private defaultFooterTemplate;
    /**
     * Exporte avec citations BibTeX resolues
     */
    exportWithCitations(markdown: string, bibliographyPath: string, outputPath: string, options?: PDFExportOptions): Promise<void>;
}
