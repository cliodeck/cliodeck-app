import type { Citation } from '../../../backend/types/citation.js';
import { BibliographyStatistics } from '../../../backend/services/BibliographyStats.js';
declare class BibliographyService {
    private parser;
    private exporter;
    private statsEngine;
    private citations;
    constructor();
    loadFromFile(filePath: string): Promise<Citation[]>;
    parseContent(content: string): Promise<Citation[]>;
    searchCitations(query: string): Citation[];
    getCitations(): Citation[];
    getCitationByKey(key: string): Citation | undefined;
    /**
     * Generate statistics for the current bibliography
     */
    generateStatistics(citations?: Citation[]): BibliographyStatistics;
    /**
     * Export citations to BibTeX file
     */
    exportToFile(citations: Citation[], filePath: string): Promise<void>;
    /**
     * Export citations to BibTeX string
     */
    exportToString(citations: Citation[]): string;
    /**
     * Export citations to BibTeX string with LaTeX encoding (legacy mode)
     */
    exportToStringLegacy(citations: Citation[]): string;
}
export declare const bibliographyService: BibliographyService;
export {};
