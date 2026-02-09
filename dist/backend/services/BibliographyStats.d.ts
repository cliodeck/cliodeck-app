import { Citation } from '../types/citation.js';
export interface PublicationsByYear {
    year: string;
    count: number;
}
export interface PublicationsByType {
    type: string;
    count: number;
    percentage: number;
}
export interface AuthorStats {
    name: string;
    publicationCount: number;
    coauthors: string[];
    years: string[];
}
export interface JournalStats {
    name: string;
    publicationCount: number;
    percentage: number;
}
export interface TimelineData {
    year: string;
    cumulative: number;
    annual: number;
}
export interface TagStats {
    tag: string;
    count: number;
    percentage: number;
}
export interface BibliographyStatistics {
    totalCitations: number;
    totalAuthors: number;
    totalJournals: number;
    yearRange: {
        min: string;
        max: string;
    };
    publicationsByYear: PublicationsByYear[];
    publicationsByType: PublicationsByType[];
    topAuthors: AuthorStats[];
    topJournals: JournalStats[];
    topTags: TagStats[];
    timelineData: TimelineData[];
    averageAuthorsPerPaper: number;
    citationsWithPDFs: number;
    pdfCoverage: number;
    citationsWithTags: number;
    tagCoverage: number;
}
/**
 * BibliographyStatsEngine
 * Analyzes bibliography citations and generates comprehensive statistics
 */
export declare class BibliographyStatsEngine {
    /**
     * Generate comprehensive statistics from a list of citations
     */
    generateStatistics(citations: Citation[]): BibliographyStatistics;
    /**
     * Calculate publications grouped by year
     */
    private calculatePublicationsByYear;
    /**
     * Calculate publications grouped by type
     */
    private calculatePublicationsByType;
    /**
     * Calculate author statistics
     */
    private calculateAuthorStats;
    /**
     * Calculate journal statistics
     */
    private calculateJournalStats;
    /**
     * Calculate tag statistics
     */
    private calculateTagStats;
    /**
     * Calculate timeline data (cumulative and annual)
     */
    private calculateTimelineData;
    /**
     * Calculate year range
     */
    private calculateYearRange;
    /**
     * Extract individual authors from author string
     * Handles formats: "Author1 and Author2", "Author1, Author2", etc.
     */
    private extractAuthors;
    /**
     * Format type name for display
     */
    private formatTypeName;
    /**
     * Get empty statistics object
     */
    private getEmptyStats;
}
