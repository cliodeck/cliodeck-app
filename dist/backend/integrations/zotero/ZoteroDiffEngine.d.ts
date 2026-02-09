import { Citation } from '../../types/citation';
import { ZoteroItem } from './ZoteroAPI';
export interface CitationChange {
    local: Citation;
    remote: Citation;
    modifiedFields: string[];
}
export interface SyncDiff {
    added: Citation[];
    modified: CitationChange[];
    deleted: Citation[];
    unchanged: Citation[];
}
export interface DiffOptions {
    compareAttachments?: boolean;
    ignoreDateModified?: boolean;
}
export declare class ZoteroDiffEngine {
    /**
     * Detect changes between local citations and remote Zotero items
     */
    detectChanges(localCitations: Citation[], remoteItems: ZoteroItem[], options?: DiffOptions): Promise<SyncDiff>;
    /**
     * Compare two citations and detect modified fields
     */
    private compareCitations;
    /**
     * Convert ZoteroItem to Citation format
     */
    private zoteroItemToCitation;
    /**
     * Extract year from Zotero date string
     */
    private extractYear;
    /**
     * Map Zotero item type to BibTeX type
     */
    private mapZoteroTypeToRef;
    /**
     * Normalize string for comparison (trim, lowercase, remove extra spaces)
     */
    private normalizeString;
    /**
     * Extract MD5 hashes from attachments
     */
    private getAttachmentMD5s;
    /**
     * Get summary statistics from diff
     */
    getSummary(diff: SyncDiff): {
        totalChanges: number;
        addedCount: number;
        modifiedCount: number;
        deletedCount: number;
        unchangedCount: number;
    };
    /**
     * Check if sync is needed (has any changes)
     */
    hasChanges(diff: SyncDiff): boolean;
}
