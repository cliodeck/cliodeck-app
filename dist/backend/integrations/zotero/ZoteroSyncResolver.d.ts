import { Citation } from '../../types/citation';
import { SyncDiff } from './ZoteroDiffEngine';
export type ConflictStrategy = 'local' | 'remote' | 'manual';
export interface SyncResolution {
    strategy: ConflictStrategy;
    selectedChanges: {
        added: Citation[];
        modified: Array<{
            local: Citation;
            remote: Citation;
            useRemote: boolean;
        }>;
        deleted: Citation[];
    };
}
export interface MergeResult {
    finalCitations: Citation[];
    addedCount: number;
    modifiedCount: number;
    deletedCount: number;
    skippedCount: number;
}
export declare class ZoteroSyncResolver {
    /**
     * Resolve conflicts automatically based on strategy
     */
    resolveConflicts(diff: SyncDiff, currentCitations: Citation[], strategy: ConflictStrategy, resolution?: SyncResolution): Promise<MergeResult>;
    /**
     * Apply "remote wins" strategy - accept all changes from Zotero
     */
    private applyRemoteStrategy;
    /**
     * Apply "local wins" strategy - only add new items, keep local changes
     */
    private applyLocalStrategy;
    /**
     * Apply manual resolution (user-selected changes)
     */
    private applyManualResolution;
    /**
     * Merge two citations, optionally preferring remote
     * Preserves important local data like file paths
     */
    private mergeCitations;
    /**
     * Merge attachment lists, preserving download status from local
     */
    private mergeAttachments;
    /**
     * Check if a citation has been indexed (has associated PDFs in database)
     */
    isCitationIndexed(citation: Citation, indexedPaths: Set<string>): Promise<boolean>;
    /**
     * Validate sync resolution before applying
     */
    validateResolution(resolution: SyncResolution): {
        valid: boolean;
        errors: string[];
    };
    /**
     * Create a backup of current citations before sync
     */
    createBackup(citations: Citation[]): string;
    /**
     * Generate a summary report of sync results
     */
    generateSyncReport(result: MergeResult): string;
}
