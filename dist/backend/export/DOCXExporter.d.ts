export interface DOCXExportOptions {
    title?: string;
    author?: string;
    fontSize?: number;
    lineSpacing?: number;
}
export declare class DOCXExporter {
    /**
     * Exporte du markdown en DOCX
     */
    exportToDOCX(markdown: string, outputPath: string, options?: DOCXExportOptions): Promise<void>;
    /**
     * Parse le markdown en blocs structurés
     */
    private parseMarkdown;
    private isSpecialLine;
    /**
     * Convertit les blocs en éléments DOCX
     */
    private blocksToDocxElements;
    /**
     * Crée un heading
     */
    private createHeading;
    private getHeadingLevel;
    /**
     * Crée un paragraphe avec formatting inline (bold, italic, code)
     */
    private createParagraph;
    /**
     * Parse le formatting inline (bold, italic, code, links)
     */
    private parseInlineFormatting;
    /**
     * Crée un item de liste
     */
    private createListItem;
    /**
     * Crée un bloc de code
     */
    private createCodeBlock;
    /**
     * Crée une blockquote
     */
    private createBlockquote;
    /**
     * Crée une ligne horizontale
     */
    private createHorizontalRule;
}
