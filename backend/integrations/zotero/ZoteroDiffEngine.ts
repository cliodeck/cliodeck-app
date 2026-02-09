// Zotero Diff Engine - Compares local citations with remote Zotero items

import { Citation, createCitation } from '../../types/citation';
import { ZoteroItem, ZoteroAttachment } from './ZoteroAPI';

export interface CitationChange {
  local: Citation;
  remote: Citation;
  modifiedFields: string[];
}

export interface SyncDiff {
  added: Citation[]; // New citations in Zotero, not in local
  modified: CitationChange[]; // Citations that exist in both but have differences
  deleted: Citation[]; // Citations in local but removed from Zotero
  unchanged: Citation[]; // Citations that are identical
}

export interface DiffOptions {
  compareAttachments?: boolean; // Compare PDF attachments
  ignoreDateModified?: boolean; // Ignore dateModified field (useful for testing)
}

export class ZoteroDiffEngine {
  /**
   * Detect changes between local citations and remote Zotero items
   */
  async detectChanges(
    localCitations: Citation[],
    remoteItems: ZoteroItem[],
    options: DiffOptions = {}
  ): Promise<SyncDiff> {
    const diff: SyncDiff = {
      added: [],
      modified: [],
      deleted: [],
      unchanged: [],
    };

    // Create lookup maps for efficient comparison
    const localMap = new Map<string, Citation>();
    const remoteMap = new Map<string, ZoteroItem>();

    // Index local citations by zoteroKey or bibtex key
    for (const citation of localCitations) {
      const key = citation.zoteroKey || citation.id;
      localMap.set(key, citation);
    }

    // Index remote items by key
    for (const item of remoteItems) {
      remoteMap.set(item.key, item);
    }

    // 1. Find ADDED items (in remote but not in local)
    for (const [key, remoteItem] of remoteMap) {
      if (!localMap.has(key)) {
        const remoteCitation = this.zoteroItemToCitation(remoteItem);
        diff.added.push(remoteCitation);
      }
    }

    // 2. Find DELETED items (in local but not in remote)
    for (const [key, localCitation] of localMap) {
      // Only consider citations that have a zoteroKey
      if (localCitation.zoteroKey && !remoteMap.has(localCitation.zoteroKey)) {
        diff.deleted.push(localCitation);
      }
    }

    // 3. Find MODIFIED items (exist in both but have differences)
    for (const [key, localCitation] of localMap) {
      const zoteroKey = localCitation.zoteroKey;
      if (!zoteroKey) continue; // Skip local-only citations

      const remoteItem = remoteMap.get(zoteroKey);
      if (!remoteItem) continue; // Already handled in deleted

      const remoteCitation = this.zoteroItemToCitation(remoteItem);
      const changes = this.compareCitations(localCitation, remoteCitation, options);

      if (changes.modifiedFields.length > 0) {
        diff.modified.push(changes);
      } else {
        diff.unchanged.push(localCitation);
      }
    }

    return diff;
  }

  /**
   * Compare two citations and detect modified fields
   */
  private compareCitations(
    local: Citation,
    remote: Citation,
    options: DiffOptions
  ): CitationChange {
    const modifiedFields: string[] = [];

    // Compare core fields
    const fieldsToCompare = [
      'title',
      'author',
      'year',
      'type',
      'journal',
      'publisher',
      'booktitle',
      'shortTitle',
    ];

    for (const field of fieldsToCompare) {
      const localValue = (local as any)[field] || '';
      const remoteValue = (remote as any)[field] || '';

      if (this.normalizeString(localValue) !== this.normalizeString(remoteValue)) {
        modifiedFields.push(field);
      }
    }

    // Compare attachments if requested
    if (options.compareAttachments) {
      const localAttachmentCount = local.zoteroAttachments?.length || 0;
      const remoteAttachmentCount = remote.zoteroAttachments?.length || 0;

      if (localAttachmentCount !== remoteAttachmentCount) {
        modifiedFields.push('attachments');
      } else if (localAttachmentCount > 0 && remoteAttachmentCount > 0) {
        // Compare MD5 hashes of attachments
        const localMD5s = this.getAttachmentMD5s(local.zoteroAttachments || []);
        const remoteMD5s = this.getAttachmentMD5s(remote.zoteroAttachments || []);

        if (localMD5s.sort().join(',') !== remoteMD5s.sort().join(',')) {
          modifiedFields.push('attachments');
        }
      }
    }

    return {
      local,
      remote,
      modifiedFields,
    };
  }

  /**
   * Convert ZoteroItem to Citation format
   */
  private zoteroItemToCitation(item: ZoteroItem): Citation {
    const data = item.data;

    // Extract author(s)
    const authors = data.creators
      ?.filter((c) => c.creatorType === 'author')
      .map((c) => {
        if (c.lastName && c.firstName) {
          return `${c.lastName}, ${c.firstName}`;
        } else if (c.name) {
          return c.name;
        } else if (c.lastName) {
          return c.lastName;
        }
        return 'Unknown';
      })
      .join(' and ') || 'Unknown';

    // Extract year from date
    const year = data.date ? this.extractYear(data.date) : '';

    // Generate BibTeX key (Author_Year format)
    const firstAuthor = authors.split(' and ')[0].split(',')[0].trim();
    const bibtexKey = `${firstAuthor.replace(/\s+/g, '')}_${year}`;

    return createCitation({
      id: bibtexKey,
      type: this.mapZoteroTypeToRef(data.itemType),
      author: authors,
      year,
      title: data.title || 'Untitled',
      shortTitle: data.title && data.title.length > 50 ? data.title.substring(0, 47) + '...' : undefined,
      journal: data.publicationTitle,
      publisher: data.publisher,
      zoteroKey: item.key,
      zoteroAttachments: [], // Will be populated separately
    });
  }

  /**
   * Extract year from Zotero date string
   */
  private extractYear(dateString: string): string {
    const yearMatch = dateString.match(/\d{4}/);
    return yearMatch ? yearMatch[0] : '';
  }

  /**
   * Map Zotero item type to BibTeX type
   */
  private mapZoteroTypeToRef(zoteroType: string): string {
    const mapping: Record<string, string> = {
      journalArticle: 'article',
      book: 'book',
      bookSection: 'incollection',
      conferencePaper: 'inproceedings',
      thesis: 'phdthesis',
      report: 'techreport',
      manuscript: 'unpublished',
      webpage: 'misc',
      document: 'misc',
    };

    return mapping[zoteroType] || 'misc';
  }

  /**
   * Normalize string for comparison (trim, lowercase, remove extra spaces)
   */
  private normalizeString(str: string): string {
    return str
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s]/g, ''); // Remove punctuation
  }

  /**
   * Extract MD5 hashes from attachments
   */
  private getAttachmentMD5s(attachments: any[]): string[] {
    return attachments
      .filter((att) => att.md5)
      .map((att) => att.md5)
      .sort();
  }

  /**
   * Get summary statistics from diff
   */
  getSummary(diff: SyncDiff): {
    totalChanges: number;
    addedCount: number;
    modifiedCount: number;
    deletedCount: number;
    unchangedCount: number;
  } {
    return {
      totalChanges: diff.added.length + diff.modified.length + diff.deleted.length,
      addedCount: diff.added.length,
      modifiedCount: diff.modified.length,
      deletedCount: diff.deleted.length,
      unchangedCount: diff.unchanged.length,
    };
  }

  /**
   * Check if sync is needed (has any changes)
   */
  hasChanges(diff: SyncDiff): boolean {
    return diff.added.length > 0 || diff.modified.length > 0 || diff.deleted.length > 0;
  }
}
