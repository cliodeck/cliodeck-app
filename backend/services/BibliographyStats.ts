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
  // Overview
  totalCitations: number;
  totalAuthors: number;
  totalJournals: number;
  yearRange: { min: string; max: string };

  // Publications
  publicationsByYear: PublicationsByYear[];
  publicationsByType: PublicationsByType[];

  // Top items
  topAuthors: AuthorStats[];
  topJournals: JournalStats[];
  topTags: TagStats[];

  // Timeline
  timelineData: TimelineData[];

  // Additional metrics
  averageAuthorsPerPaper: number;
  citationsWithPDFs: number;
  pdfCoverage: number; // percentage
  citationsWithTags: number;
  tagCoverage: number; // percentage
}

/**
 * BibliographyStatsEngine
 * Analyzes bibliography citations and generates comprehensive statistics
 */
export class BibliographyStatsEngine {
  /**
   * Generate comprehensive statistics from a list of citations
   */
  generateStatistics(citations: Citation[]): BibliographyStatistics {
    if (citations.length === 0) {
      return this.getEmptyStats();
    }

    const totalCitations = citations.length;

    // Calculate all statistics
    const publicationsByYear = this.calculatePublicationsByYear(citations);
    const publicationsByType = this.calculatePublicationsByType(citations);
    const authorStats = this.calculateAuthorStats(citations);
    const journalStats = this.calculateJournalStats(citations);
    const tagStats = this.calculateTagStats(citations);
    const timelineData = this.calculateTimelineData(citations);
    const yearRange = this.calculateYearRange(citations);

    // PDF statistics
    const citationsWithPDFs = citations.filter(c => c.file || (c.zoteroAttachments && c.zoteroAttachments.length > 0)).length;
    const pdfCoverage = (citationsWithPDFs / totalCitations) * 100;

    // Tag statistics
    const citationsWithTags = citations.filter(c => c.tags && c.tags.length > 0).length;
    const tagCoverage = (citationsWithTags / totalCitations) * 100;

    // Author metrics
    const totalAuthors = authorStats.length;
    const totalAuthorInstances = citations.reduce((sum, citation) => {
      return sum + this.extractAuthors(citation.author).length;
    }, 0);
    const averageAuthorsPerPaper = totalAuthorInstances / totalCitations;

    return {
      totalCitations,
      totalAuthors,
      totalJournals: journalStats.length,
      yearRange,
      publicationsByYear,
      publicationsByType,
      topAuthors: authorStats.slice(0, 10), // Top 10
      topJournals: journalStats.slice(0, 10), // Top 10
      topTags: tagStats.slice(0, 15), // Top 15
      timelineData,
      averageAuthorsPerPaper: Math.round(averageAuthorsPerPaper * 10) / 10,
      citationsWithPDFs,
      pdfCoverage: Math.round(pdfCoverage * 10) / 10,
      citationsWithTags,
      tagCoverage: Math.round(tagCoverage * 10) / 10,
    };
  }

  /**
   * Calculate publications grouped by year
   */
  private calculatePublicationsByYear(citations: Citation[]): PublicationsByYear[] {
    const yearMap = new Map<string, number>();

    for (const citation of citations) {
      const year = citation.year || 'Unknown';
      yearMap.set(year, (yearMap.get(year) || 0) + 1);
    }

    return Array.from(yearMap.entries())
      .map(([year, count]) => ({ year, count }))
      .sort((a, b) => {
        if (a.year === 'Unknown') return 1;
        if (b.year === 'Unknown') return -1;
        return parseInt(a.year) - parseInt(b.year);
      });
  }

  /**
   * Calculate publications grouped by type
   */
  private calculatePublicationsByType(citations: Citation[]): PublicationsByType[] {
    const typeMap = new Map<string, number>();
    const total = citations.length;

    for (const citation of citations) {
      const type = citation.type || 'unknown';
      typeMap.set(type, (typeMap.get(type) || 0) + 1);
    }

    return Array.from(typeMap.entries())
      .map(([type, count]) => ({
        type: this.formatTypeName(type),
        count,
        percentage: Math.round((count / total) * 100 * 10) / 10,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Calculate author statistics
   */
  private calculateAuthorStats(citations: Citation[]): AuthorStats[] {
    const authorMap = new Map<string, {
      publicationCount: number;
      coauthors: Set<string>;
      years: Set<string>;
    }>();

    for (const citation of citations) {
      const authors = this.extractAuthors(citation.author);
      const year = citation.year || 'Unknown';

      for (const author of authors) {
        if (!authorMap.has(author)) {
          authorMap.set(author, {
            publicationCount: 0,
            coauthors: new Set(),
            years: new Set(),
          });
        }

        const stats = authorMap.get(author)!;
        stats.publicationCount++;
        stats.years.add(year);

        // Add coauthors
        for (const coauthor of authors) {
          if (coauthor !== author) {
            stats.coauthors.add(coauthor);
          }
        }
      }
    }

    return Array.from(authorMap.entries())
      .map(([name, data]) => ({
        name,
        publicationCount: data.publicationCount,
        coauthors: Array.from(data.coauthors),
        years: Array.from(data.years).sort(),
      }))
      .sort((a, b) => b.publicationCount - a.publicationCount);
  }

  /**
   * Calculate journal statistics
   */
  private calculateJournalStats(citations: Citation[]): JournalStats[] {
    const journalMap = new Map<string, number>();
    const total = citations.filter(c => c.journal).length;

    for (const citation of citations) {
      if (citation.journal) {
        const journal = citation.journal;
        journalMap.set(journal, (journalMap.get(journal) || 0) + 1);
      }
    }

    return Array.from(journalMap.entries())
      .map(([name, count]) => ({
        name,
        publicationCount: count,
        percentage: total > 0 ? Math.round((count / total) * 100 * 10) / 10 : 0,
      }))
      .sort((a, b) => b.publicationCount - a.publicationCount);
  }

  /**
   * Calculate tag statistics
   */
  private calculateTagStats(citations: Citation[]): TagStats[] {
    const tagMap = new Map<string, number>();
    const total = citations.length;

    for (const citation of citations) {
      if (citation.tags && citation.tags.length > 0) {
        for (const tag of citation.tags) {
          tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
        }
      }
    }

    return Array.from(tagMap.entries())
      .map(([tag, count]) => ({
        tag,
        count,
        percentage: Math.round((count / total) * 100 * 10) / 10,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Calculate timeline data (cumulative and annual)
   */
  private calculateTimelineData(citations: Citation[]): TimelineData[] {
    const yearMap = new Map<string, number>();

    // Count publications per year
    for (const citation of citations) {
      const year = citation.year || 'Unknown';
      if (year !== 'Unknown') {
        yearMap.set(year, (yearMap.get(year) || 0) + 1);
      }
    }

    // Sort years
    const sortedYears = Array.from(yearMap.keys()).sort((a, b) => parseInt(a) - parseInt(b));

    // Calculate cumulative
    let cumulative = 0;
    return sortedYears.map(year => {
      const annual = yearMap.get(year) || 0;
      cumulative += annual;
      return {
        year,
        annual,
        cumulative,
      };
    });
  }

  /**
   * Calculate year range
   */
  private calculateYearRange(citations: Citation[]): { min: string; max: string } {
    const years = citations
      .map(c => c.year)
      .filter(y => y && y !== 'Unknown')
      .map(y => parseInt(y!))
      .filter(y => !isNaN(y));

    if (years.length === 0) {
      return { min: 'Unknown', max: 'Unknown' };
    }

    return {
      min: Math.min(...years).toString(),
      max: Math.max(...years).toString(),
    };
  }

  /**
   * Extract individual authors from author string
   * Handles formats: "Author1 and Author2", "Author1, Author2", etc.
   */
  private extractAuthors(authorString?: string): string[] {
    if (!authorString) return [];

    return authorString
      .split(/\s+and\s+|\s*,\s*|\s*;\s*/)
      .map(author => author.trim())
      .filter(author => author.length > 0);
  }

  /**
   * Format type name for display
   */
  private formatTypeName(type: string): string {
    const typeMap: Record<string, string> = {
      article: 'Journal Article',
      book: 'Book',
      inproceedings: 'Conference Paper',
      incollection: 'Book Chapter',
      phdthesis: 'PhD Thesis',
      mastersthesis: 'Master Thesis',
      techreport: 'Technical Report',
      misc: 'Miscellaneous',
      unpublished: 'Unpublished',
      unknown: 'Unknown',
    };

    return typeMap[type.toLowerCase()] || type;
  }

  /**
   * Get empty statistics object
   */
  private getEmptyStats(): BibliographyStatistics {
    return {
      totalCitations: 0,
      totalAuthors: 0,
      totalJournals: 0,
      yearRange: { min: 'Unknown', max: 'Unknown' },
      publicationsByYear: [],
      publicationsByType: [],
      topAuthors: [],
      topJournals: [],
      timelineData: [],
      averageAuthorsPerPaper: 0,
      citationsWithPDFs: 0,
      pdfCoverage: 0,
      topTags: [],
      citationsWithTags: 0,
      tagCoverage: 0,
    };
  }
}
