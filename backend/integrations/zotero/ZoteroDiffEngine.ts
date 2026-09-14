// Zotero Diff Engine - Compares local citations with remote Zotero items

import { Citation, type ZoteroNote, type ZoteroTag } from '../../types/citation';
import { ZoteroItem, ZoteroAttachment } from './ZoteroAPI';
import { assignCiteKeys } from '../../core/bibliography/citekey';
import { zoteroItemToCitation, ZOTERO_OWNED_FIELDS } from './toCitation';

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

/** Empreinte stable d'une liste de tags Zotero (ordre indifférent). */
function tagSignature(tags: ZoteroTag[] | undefined): string {
  return (tags ?? []).map((t) => `${t.automatic ? 'a' : 'm'}:${t.tag}`).sort().join('\u0000');
}

/** Empreinte stable des notes Zotero (ordre indifférent). */
function noteSignature(notes: ZoteroNote[] | undefined): string {
  return (notes ?? []).map((n) => `${n.key}:${n.text}`).sort().join('\u0000');
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
    // Les clés des nouvelles entrées sont attribuées en bloc, en réservant
    // d'abord celles déjà prises localement : sans quoi un item arrivant de
    // Zotero écrase la clé d'une référence déjà citée dans le manuscrit.
    const addedItems: ZoteroItem[] = [];
    for (const [key, remoteItem] of remoteMap) {
      if (!localMap.has(key)) {
        addedItems.push(remoteItem);
      }
    }
    const takenKeys = new Set(localCitations.map((c) => c.id));
    const addedKeys = assignCiteKeys(addedItems, takenKeys);
    for (const remoteItem of addedItems) {
      diff.added.push(zoteroItemToCitation(remoteItem, addedKeys.get(remoteItem.key)!));
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

      // La clé locale est conservée : c'est celle que l'auteur a écrite dans
      // son texte. Une mise à jour de métadonnées dans Zotero (année
      // corrigée, prénom complété) ne doit pas renommer une citation en
      // place — la réparation des clés passe par un réimport complet.
      const remoteCitation = zoteroItemToCitation(remoteItem, localCitation.id);
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
      'editor',
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

    // Tags et notes Zotero : comparés seulement s'ils ont été lus. Un
    // ancien champ `tags` (tags Zotero écrits dans le .bib par une version
    // précédente) rend l'entrée « modifiée », pour qu'il en sorte.
    if (remote.zoteroTags !== undefined && tagSignature(local.zoteroTags) !== tagSignature(remote.zoteroTags)) {
      modifiedFields.push('zoteroTags');
    }
    if (remote.zoteroNotes !== undefined && noteSignature(local.zoteroNotes) !== noteSignature(remote.zoteroNotes)) {
      modifiedFields.push('zoteroNotes');
    }
    if (local.zoteroKey && (local.tags?.length ?? 0) > 0) {
      modifiedFields.push('tags');
    }

    // Champs BibLaTeX que Zotero alimente (URL, DOI, pages, date complète…).
    // Sans cette comparaison, une entrée importée avant qu'on les exporte
    // ne les recevait jamais par la synchronisation : rien n'y paraissait
    // « modifié ».
    for (const field of ZOTERO_OWNED_FIELDS) {
      const localValue = local.customFields?.[field] ?? '';
      const remoteValue = remote.customFields?.[field] ?? '';

      if (this.normalizeString(localValue) !== this.normalizeString(remoteValue)) {
        modifiedFields.push(field);
      }
    }

    // Compare attachments if requested
    // Pièces jointes non lues côté Zotero (`undefined`) : rien à comparer.
    if (options.compareAttachments && remote.zoteroAttachments !== undefined) {
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
