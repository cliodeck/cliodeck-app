// @ts-nocheck
import { BibTeXParser } from '../../../backend/core/bibliography/BibTeXParser.js';
import { BibTeXExporter } from '../../../backend/core/bibliography/BibTeXExporter.js';
import { BibliographyStatsEngine } from '../../../backend/services/BibliographyStats.js';
class BibliographyService {
    constructor() {
        this.citations = [];
        this.parser = new BibTeXParser();
        this.exporter = new BibTeXExporter();
        this.statsEngine = new BibliographyStatsEngine();
    }
    async loadFromFile(filePath) {
        try {
            this.citations = this.parser.parseFile(filePath);
            console.log(`✅ Bibliography loaded: ${this.citations.length} citations`);
            return this.citations;
        }
        catch (error) {
            console.error('❌ Failed to load bibliography:', error);
            throw error;
        }
    }
    async parseContent(content) {
        try {
            this.citations = this.parser.parse(content);
            console.log(`✅ Bibliography parsed: ${this.citations.length} citations`);
            return this.citations;
        }
        catch (error) {
            console.error('❌ Failed to parse bibliography:', error);
            throw error;
        }
    }
    searchCitations(query) {
        if (!query)
            return this.citations;
        const lowerQuery = query.toLowerCase();
        return this.citations.filter((citation) => citation.title?.toLowerCase().includes(lowerQuery) ||
            citation.author?.toLowerCase().includes(lowerQuery) ||
            citation.key?.toLowerCase().includes(lowerQuery) ||
            citation.year?.toString().includes(query));
    }
    getCitations() {
        return this.citations;
    }
    getCitationByKey(key) {
        return this.citations.find((c) => c.key === key);
    }
    /**
     * Generate statistics for the current bibliography
     */
    generateStatistics(citations) {
        const citationsToAnalyze = citations || this.citations;
        return this.statsEngine.generateStatistics(citationsToAnalyze);
    }
    /**
     * Export citations to BibTeX file
     */
    async exportToFile(citations, filePath) {
        try {
            await this.exporter.exportToFile(citations, filePath);
            console.log(`✅ Bibliography exported: ${citations.length} citations to ${filePath}`);
        }
        catch (error) {
            console.error('❌ Failed to export bibliography:', error);
            throw error;
        }
    }
    /**
     * Export citations to BibTeX string
     */
    exportToString(citations) {
        return this.exporter.exportToString(citations);
    }
    /**
     * Export citations to BibTeX string with LaTeX encoding (legacy mode)
     */
    exportToStringLegacy(citations) {
        return this.exporter.exportToStringLegacy(citations);
    }
}
export const bibliographyService = new BibliographyService();
