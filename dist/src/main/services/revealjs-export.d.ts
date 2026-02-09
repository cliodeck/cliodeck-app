export interface RevealJsExportOptions {
    projectPath: string;
    content: string;
    outputPath?: string;
    metadata?: {
        title?: string;
        author?: string;
        date?: string;
    };
    config?: {
        theme?: 'black' | 'white' | 'league' | 'beige' | 'sky' | 'night' | 'serif' | 'simple' | 'solarized' | 'blood' | 'moon';
        transition?: 'none' | 'fade' | 'slide' | 'convex' | 'concave' | 'zoom';
        controls?: boolean;
        progress?: boolean;
        slideNumber?: boolean;
        history?: boolean;
        keyboard?: boolean;
        overview?: boolean;
        center?: boolean;
        touch?: boolean;
        loop?: boolean;
        rtl?: boolean;
        shuffle?: boolean;
        fragments?: boolean;
        embedded?: boolean;
        help?: boolean;
        showNotes?: boolean;
        autoSlide?: number;
        autoSlideStoppable?: boolean;
        mouseWheel?: boolean;
        hideAddressBar?: boolean;
        previewLinks?: boolean;
        transitionSpeed?: 'default' | 'fast' | 'slow';
        backgroundTransition?: 'none' | 'fade' | 'slide' | 'convex' | 'concave' | 'zoom';
        viewDistance?: number;
        parallaxBackgroundImage?: string;
        parallaxBackgroundSize?: string;
    };
}
interface RevealJsProgress {
    stage: 'preparing' | 'converting' | 'complete';
    message: string;
    progress: number;
}
export declare class RevealJsExportService {
    /**
     * Export markdown to reveal.js HTML presentation
     */
    exportToRevealJs(options: RevealJsExportOptions, onProgress?: (progress: RevealJsProgress) => void): Promise<{
        success: boolean;
        outputPath?: string;
        error?: string;
    }>;
}
export declare const revealJsExportService: RevealJsExportService;
export {};
