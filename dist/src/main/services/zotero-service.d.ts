import { Citation } from '../../../backend/types/citation.js';
import { SyncDiff } from '../../../backend/integrations/zotero/ZoteroDiffEngine.js';
import { ConflictStrategy, SyncResolution } from '../../../backend/integrations/zotero/ZoteroSyncResolver.js';
declare class ZoteroService {
    /**
     * Test connection to Zotero API
     */
    testConnection(userId: string, apiKey: string, groupId?: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * List all collections from Zotero with hierarchy
     */
    listCollections(userId: string, apiKey: string, groupId?: string): Promise<{
        success: boolean;
        collections?: Array<{
            key: string;
            name: string;
            parentCollection?: string;
        }>;
        error?: string;
    }>;
    /**
     * Sort collections hierarchically (top-level first, then children indented)
     */
    private sortCollectionsHierarchically;
    /**
     * Sync Zotero collection to local project
     */
    sync(options: {
        userId: string;
        apiKey: string;
        groupId?: string;
        collectionKey?: string;
        downloadPDFs: boolean;
        exportBibTeX: boolean;
        targetDirectory?: string;
    }): Promise<{
        success: boolean;
        itemCount?: number;
        pdfCount?: number;
        bibtexPath?: string;
        collections?: Array<{
            key: string;
            name: string;
            parentKey?: string;
        }>;
        itemCollectionMap?: Record<string, string[]>;
        bibtexKeyToCollections?: Record<string, string[]>;
        error?: string;
    }>;
    /**
     * Download a specific PDF attachment from Zotero
     */
    downloadPDF(options: {
        userId: string;
        apiKey: string;
        groupId?: string;
        attachmentKey: string;
        filename: string;
        targetDirectory: string;
    }): Promise<{
        success: boolean;
        filePath?: string;
        error?: string;
    }>;
    /**
     * Enrich citations with Zotero attachment information
     */
    enrichCitations(options: {
        userId: string;
        apiKey: string;
        groupId?: string;
        citations: Citation[];
        collectionKey?: string;
    }): Promise<{
        success: boolean;
        citations?: Citation[];
        error?: string;
    }>;
    /**
     * Check for updates from Zotero collection
     */
    checkUpdates(options: {
        userId: string;
        apiKey: string;
        groupId?: string;
        localCitations: Citation[];
        collectionKey?: string;
    }): Promise<{
        success: boolean;
        diff?: SyncDiff;
        hasChanges?: boolean;
        summary?: {
            totalChanges: number;
            addedCount: number;
            modifiedCount: number;
            deletedCount: number;
            unchangedCount: number;
        };
        error?: string;
    }>;
    /**
     * Apply updates from Zotero
     */
    applyUpdates(options: {
        userId: string;
        apiKey: string;
        groupId?: string;
        currentCitations: Citation[];
        diff: SyncDiff;
        strategy: ConflictStrategy;
        resolution?: SyncResolution;
    }): Promise<{
        success: boolean;
        finalCitations?: Citation[];
        addedCount?: number;
        modifiedCount?: number;
        deletedCount?: number;
        skippedCount?: number;
        error?: string;
    }>;
    /**
     * Refresh collection links by fetching current Zotero data
     * Used after apply-updates to ensure document-collection links are current
     *
     * @param options.localCitations Local citations with their bibtexKey (id) and zoteroKey
     *   This is needed because the bibtexKey in documents comes from Better BibTeX format,
     *   not from a simple Author_Year generation.
     */
    refreshCollectionLinks(options: {
        userId: string;
        apiKey: string;
        groupId?: string;
        collectionKey?: string;
        localCitations?: Array<{
            id: string;
            zoteroKey?: string;
            title?: string;
        }>;
    }): Promise<{
        collections: Array<{
            key: string;
            name: string;
            parentKey?: string;
        }>;
        bibtexKeyToCollections: Record<string, string[]>;
    }>;
}
export declare const zoteroService: ZoteroService;
export {};
