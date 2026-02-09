// Zotero Sync Resolver - Resolves conflicts between local and remote citations
import { createCitation } from '../../types/citation.js';
export class ZoteroSyncResolver {
    /**
     * Resolve conflicts automatically based on strategy
     */
    async resolveConflicts(diff, currentCitations, strategy, resolution) {
        let finalCitations = [...currentCitations];
        let addedCount = 0;
        let modifiedCount = 0;
        let deletedCount = 0;
        let skippedCount = 0;
        // If manual strategy and resolution provided, use it
        if (strategy === 'manual' && resolution) {
            return this.applyManualResolution(currentCitations, resolution);
        }
        // Automatic resolution based on strategy
        switch (strategy) {
            case 'remote':
                // Remote wins - apply all changes from Zotero
                ({ finalCitations, addedCount, modifiedCount, deletedCount } = this.applyRemoteStrategy(finalCitations, diff));
                break;
            case 'local':
                // Local wins - only add new items, skip modifications and deletions
                ({ finalCitations, addedCount, skippedCount } = this.applyLocalStrategy(finalCitations, diff));
                break;
            default:
                throw new Error(`Unknown conflict strategy: ${strategy}`);
        }
        return {
            finalCitations,
            addedCount,
            modifiedCount,
            deletedCount,
            skippedCount,
        };
    }
    /**
     * Apply "remote wins" strategy - accept all changes from Zotero
     */
    applyRemoteStrategy(citations, diff) {
        let finalCitations = [...citations];
        let addedCount = 0;
        let modifiedCount = 0;
        let deletedCount = 0;
        // 1. Add new citations
        for (const addedCitation of diff.added) {
            finalCitations.push(addedCitation);
            addedCount++;
        }
        // 2. Update modified citations
        for (const change of diff.modified) {
            const index = finalCitations.findIndex((c) => c.id === change.local.id);
            if (index !== -1) {
                // Preserve local file path if exists
                const mergedCitation = this.mergeCitations(change.local, change.remote, true);
                finalCitations[index] = mergedCitation;
                modifiedCount++;
            }
        }
        // 3. Delete removed citations
        for (const deletedCitation of diff.deleted) {
            const index = finalCitations.findIndex((c) => c.id === deletedCitation.id);
            if (index !== -1) {
                finalCitations.splice(index, 1);
                deletedCount++;
            }
        }
        return { finalCitations, addedCount, modifiedCount, deletedCount };
    }
    /**
     * Apply "local wins" strategy - only add new items, keep local changes
     */
    applyLocalStrategy(citations, diff) {
        let finalCitations = [...citations];
        let addedCount = 0;
        let skippedCount = 0;
        // Only add new citations
        for (const addedCitation of diff.added) {
            finalCitations.push(addedCitation);
            addedCount++;
        }
        // Skip modifications
        skippedCount += diff.modified.length;
        // Skip deletions (keep local)
        skippedCount += diff.deleted.length;
        return { finalCitations, addedCount, skippedCount };
    }
    /**
     * Apply manual resolution (user-selected changes)
     */
    applyManualResolution(citations, resolution) {
        let finalCitations = [...citations];
        let addedCount = 0;
        let modifiedCount = 0;
        let deletedCount = 0;
        let skippedCount = 0;
        // 1. Add selected new citations
        for (const addedCitation of resolution.selectedChanges.added) {
            finalCitations.push(addedCitation);
            addedCount++;
        }
        // 2. Apply selected modifications
        for (const change of resolution.selectedChanges.modified) {
            const index = finalCitations.findIndex((c) => c.id === change.local.id);
            if (index !== -1) {
                if (change.useRemote) {
                    const mergedCitation = this.mergeCitations(change.local, change.remote, true);
                    finalCitations[index] = mergedCitation;
                    modifiedCount++;
                }
                else {
                    // Keep local - no change needed
                    skippedCount++;
                }
            }
        }
        // 3. Delete selected citations
        for (const deletedCitation of resolution.selectedChanges.deleted) {
            const index = finalCitations.findIndex((c) => c.id === deletedCitation.id);
            if (index !== -1) {
                finalCitations.splice(index, 1);
                deletedCount++;
            }
        }
        return {
            finalCitations,
            addedCount,
            modifiedCount,
            deletedCount,
            skippedCount,
        };
    }
    /**
     * Merge two citations, optionally preferring remote
     * Preserves important local data like file paths
     */
    mergeCitations(local, remote, preferRemote) {
        if (preferRemote) {
            // Take remote data but preserve local file path and indexing info
            return createCitation({
                ...remote,
                file: local.file, // Preserve local PDF path
                // If remote has attachments, merge with local downloaded status
                zoteroAttachments: this.mergeAttachments(local.zoteroAttachments || [], remote.zoteroAttachments || []),
            });
        }
        else {
            // Keep local but update Zotero metadata
            return createCitation({
                ...local,
                zoteroAttachments: this.mergeAttachments(local.zoteroAttachments || [], remote.zoteroAttachments || []),
            });
        }
    }
    /**
     * Merge attachment lists, preserving download status from local
     */
    mergeAttachments(localAttachments, remoteAttachments) {
        const merged = [];
        const localMap = new Map(localAttachments.map((att) => [att.key, att]));
        for (const remoteAtt of remoteAttachments) {
            const localAtt = localMap.get(remoteAtt.key);
            if (localAtt) {
                // Merge: take remote metadata but preserve local download status
                merged.push({
                    ...remoteAtt,
                    downloaded: localAtt.downloaded,
                });
            }
            else {
                // New attachment from remote
                merged.push(remoteAtt);
            }
        }
        return merged;
    }
    /**
     * Check if a citation has been indexed (has associated PDFs in database)
     */
    async isCitationIndexed(citation, indexedPaths) {
        if (!citation.file)
            return false;
        return indexedPaths.has(citation.file);
    }
    /**
     * Validate sync resolution before applying
     */
    validateResolution(resolution) {
        const errors = [];
        // Check if resolution is provided for manual strategy
        if (resolution.strategy === 'manual') {
            if (!resolution.selectedChanges) {
                errors.push('Manual strategy requires selectedChanges');
            }
        }
        return {
            valid: errors.length === 0,
            errors,
        };
    }
    /**
     * Create a backup of current citations before sync
     */
    createBackup(citations) {
        const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
        const backupData = JSON.stringify(citations, null, 2);
        return backupData;
    }
    /**
     * Generate a summary report of sync results
     */
    generateSyncReport(result) {
        const lines = [];
        lines.push('=== Zotero Sync Report ===');
        lines.push(`Added: ${result.addedCount} citations`);
        lines.push(`Modified: ${result.modifiedCount} citations`);
        lines.push(`Deleted: ${result.deletedCount} citations`);
        if (result.skippedCount > 0) {
            lines.push(`Skipped: ${result.skippedCount} citations (local changes preserved)`);
        }
        lines.push(`Total citations after sync: ${result.finalCitations.length}`);
        lines.push('=========================');
        return lines.join('\n');
    }
}
