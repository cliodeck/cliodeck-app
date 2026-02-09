import type { Citation, ZoteroAttachmentInfo } from '../types/citation';
/**
 * Metadata stored for each citation (data that can't be stored in BibTeX)
 */
export interface CitationMetadata {
    id: string;
    zoteroKey?: string;
    zoteroAttachments?: ZoteroAttachmentInfo[];
    dateAdded?: string;
    dateModified?: string;
}
/**
 * Structure of the metadata file
 */
export interface BibliographyMetadataFile {
    version: number;
    lastUpdated: string;
    citations: Record<string, CitationMetadata>;
}
/**
 * Service for persisting bibliography metadata that can't be stored in BibTeX
 *
 * This includes Zotero attachment information (keys, filenames, MD5 hashes, etc.)
 * which is needed to:
 * - Display PDF download buttons
 * - Show indexing status
 * - Detect modified PDFs
 */
export declare class BibliographyMetadataService {
    private static readonly METADATA_FILENAME;
    private static readonly CURRENT_VERSION;
    /**
     * Get the path to the metadata file for a project
     */
    static getMetadataPath(projectPath: string): string;
    /**
     * Save metadata for citations
     * Only saves metadata that can't be stored in BibTeX (zoteroAttachments, etc.)
     */
    static saveMetadata(projectPath: string, citations: Citation[]): Promise<void>;
    /**
     * Load metadata from file
     */
    static loadMetadata(projectPath: string): Promise<BibliographyMetadataFile | null>;
    /**
     * Merge metadata into citations
     * This is called when loading a bibliography to restore Zotero-specific data
     */
    static mergeCitationsWithMetadata(citations: Citation[], metadata: BibliographyMetadataFile | null): Citation[];
    /**
     * Update metadata for specific citations (partial update)
     * Useful when downloading a single PDF
     */
    static updateCitationMetadata(projectPath: string, citationId: string, updates: Partial<CitationMetadata>): Promise<void>;
    /**
     * Check if metadata file exists for a project
     */
    static hasMetadata(projectPath: string): boolean;
}
