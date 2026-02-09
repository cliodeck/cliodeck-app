export interface ExportOptions {
    projectPath: string;
    projectType: 'article' | 'book' | 'presentation';
    content: string;
    outputPath?: string;
    bibliographyPath?: string;
    cslPath?: string;
    metadata?: {
        title?: string;
        author?: string;
        date?: string;
        abstract?: string;
    };
    beamerConfig?: {
        theme?: string;
        colortheme?: string;
        fonttheme?: string;
        aspectratio?: string;
        navigation?: boolean;
        showNotes?: boolean;
        institute?: string;
        logo?: string;
        titlegraphic?: string;
        showToc?: boolean;
        tocBeforeSection?: boolean;
        showFrameNumber?: boolean;
        frameNumberStyle?: 'total' | 'simple' | 'none';
        showSectionNumber?: boolean;
        sectionNumberInToc?: boolean;
        showAuthorInFooter?: boolean;
        showTitleInFooter?: boolean;
        showDateInFooter?: boolean;
        incremental?: boolean;
        overlays?: boolean;
    };
}
interface PandocProgress {
    stage: 'preparing' | 'converting' | 'compiling' | 'complete';
    message: string;
    progress: number;
}
export declare class PDFExportService {
    /**
     * Get the extended PATH for macOS that includes Homebrew and MacTeX paths
     * GUI apps on macOS don't inherit the user's shell PATH
     */
    private getExtendedPath;
    /**
     * Check if pandoc and xelatex are available
     */
    checkDependencies(): Promise<{
        pandoc: boolean;
        xelatex: boolean;
    }>;
    /**
     * Export markdown to PDF using pandoc and xelatex
     */
    exportToPDF(options: ExportOptions, onProgress?: (progress: PandocProgress) => void): Promise<{
        success: boolean;
        outputPath?: string;
        error?: string;
    }>;
}
export declare const pdfExportService: PDFExportService;
export {};
