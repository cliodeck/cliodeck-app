export interface WordExportOptions {
    projectPath: string;
    projectType: 'article' | 'book' | 'presentation';
    content: string;
    outputPath?: string;
    bibliographyPath?: string;
    cslPath?: string;
    templatePath?: string;
    metadata?: {
        title?: string;
        author?: string;
        date?: string;
        abstract?: string;
    };
}
interface WordExportProgress {
    stage: 'preparing' | 'parsing' | 'generating' | 'template' | 'pandoc' | 'complete';
    message: string;
    progress: number;
}
export declare class WordExportService {
    private parser;
    /**
     * Get the extended PATH for macOS that includes Homebrew and MacTeX paths
     * GUI apps on macOS don't inherit the user's shell PATH
     */
    private getExtendedPath;
    /**
     * Check if pandoc is available
     */
    private checkPandoc;
    /**
     * Export markdown to Word using pandoc (for bibliography support)
     */
    private exportWithPandoc;
    /**
     * Export markdown to Word document (.docx)
     * Uses pandoc when bibliography is available for proper citation processing
     */
    exportToWord(options: WordExportOptions, onProgress?: (progress: WordExportProgress) => void): Promise<{
        success: boolean;
        outputPath?: string;
        error?: string;
    }>;
    /**
     * Merge content with a Word template (.dotx)
     */
    private mergeWithTemplate;
    /**
     * Check if a .dotx template exists in the project directory
     */
    findTemplate(projectPath: string): Promise<string | null>;
}
export declare const wordExportService: WordExportService;
export {};
