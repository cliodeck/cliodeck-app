// Zotero Sync Resolver - Resolves conflicts between local and remote citations

import { Citation, createCitation, type ZoteroAttachmentInfo } from '../../types/citation';
import { SyncDiff, CitationChange } from './ZoteroDiffEngine';
import { ZOTERO_OWNED_FIELDS } from './toCitation';

export type ConflictStrategy = 'local' | 'remote' | 'manual';

export interface SyncResolution {
  strategy: ConflictStrategy;
  selectedChanges: {
    added: Citation[];
    modified: Array<{ local: Citation; remote: Citation; useRemote: boolean }>;
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

/**
 * Champs réellement renseignés d'une citation : ni `undefined`, ni chaîne
 * vide, ni tableau vide. Sert à fusionner sans effacer ce que Zotero ne
 * connaît pas (notes, mots-clés, champs BibTeX personnalisés, PDF local).
 */
function definedFields(citation: Citation): Partial<Citation> {
  // `createCitation` redéfinit ces propriétés calculées : les recopier ne
  // sert à rien et brouille la lecture du diff.
  const computed = new Set(['displayString', 'details', 'hasPDF', 'hasZoteroPDFs']);
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(citation)) {
    if (computed.has(field)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[field] = value;
  }
  return out as Partial<Citation>;
}

/**
 * Fusion des champs BibLaTeX libres. Ceux que Zotero alimente (URL, DOI,
 * pages…) suivent Zotero, disparition comprise ; les autres — ajoutés à la
 * main dans le .bib — restent.
 */
function mergeCustomFields(
  local: Record<string, string> | undefined,
  remote: Record<string, string> | undefined
): Record<string, string> | undefined {
  const owned = new Set<string>(ZOTERO_OWNED_FIELDS);
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(local ?? {})) {
    if (!owned.has(name)) merged[name] = value;
  }
  Object.assign(merged, remote ?? {});
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export class ZoteroSyncResolver {
  /**
   * Retrouve une citation dans la liste courante.
   *
   * Le `zoteroKey` fait foi dès que la cible en porte un : la clé BibTeX
   * n'est qu'un libellé, et rien ne la rend unique. Mesuré sur une
   * collection réelle : trois œuvres sans rapport partageaient
   * `Unknown_2022`, deux articles `Hutchinson_2024`. Apparier sur `id`
   * faisait porter une modification — ou une suppression — à l'homonyme
   * arrivé en premier dans la liste, donc perdre une référence et en
   * dupliquer une autre.
   *
   * Pas de repli sur `id` quand la cible a un `zoteroKey` inconnu de la
   * liste : mieux vaut ne rien toucher que toucher la mauvaise entrée.
   */
  private indexOfCitation(citations: Citation[], target: Citation): number {
    if (target.zoteroKey) {
      return citations.findIndex((c) => c.zoteroKey === target.zoteroKey);
    }
    return citations.findIndex((c) => !c.zoteroKey && c.id === target.id);
  }

  /**
   * Resolve conflicts automatically based on strategy
   */
  async resolveConflicts(
    diff: SyncDiff,
    currentCitations: Citation[],
    strategy: ConflictStrategy,
    resolution?: SyncResolution
  ): Promise<MergeResult> {
    let finalCitations: Citation[] = [...currentCitations];
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
        ({ finalCitations, addedCount, modifiedCount, deletedCount } = this.applyRemoteStrategy(
          finalCitations,
          diff
        ));
        break;

      case 'local':
        // Local wins - only add new items, skip modifications and deletions
        ({ finalCitations, addedCount, skippedCount } = this.applyLocalStrategy(
          finalCitations,
          diff
        ));
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
  private applyRemoteStrategy(
    citations: Citation[],
    diff: SyncDiff
  ): {
    finalCitations: Citation[];
    addedCount: number;
    modifiedCount: number;
    deletedCount: number;
  } {
    const finalCitations = [...citations];
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
      const index = this.indexOfCitation(finalCitations, change.local);
      if (index !== -1) {
        // Preserve local file path if exists
        const mergedCitation = this.mergeCitations(change.local, change.remote, true);
        finalCitations[index] = mergedCitation;
        modifiedCount++;
      }
    }

    // 3. Delete removed citations
    for (const deletedCitation of diff.deleted) {
      const index = this.indexOfCitation(finalCitations, deletedCitation);
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
  private applyLocalStrategy(
    citations: Citation[],
    diff: SyncDiff
  ): {
    finalCitations: Citation[];
    addedCount: number;
    skippedCount: number;
  } {
    const finalCitations = [...citations];
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
  private applyManualResolution(
    citations: Citation[],
    resolution: SyncResolution
  ): MergeResult {
    const finalCitations = [...citations];
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
      const index = this.indexOfCitation(finalCitations, change.local);
      if (index !== -1) {
        if (change.useRemote) {
          const mergedCitation = this.mergeCitations(change.local, change.remote, true);
          finalCitations[index] = mergedCitation;
          modifiedCount++;
        } else {
          // Keep local - no change needed
          skippedCount++;
        }
      }
    }

    // 3. Delete selected citations
    for (const deletedCitation of resolution.selectedChanges.deleted) {
      const index = this.indexOfCitation(finalCitations, deletedCitation);
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
  private mergeCitations(local: Citation, remote: Citation, preferRemote: boolean): Citation {
    if (preferRemote) {
      // « Le distant gagne » ne vaut que sur ce que Zotero sait : on part de
      // l'entrée locale et on n'écrase qu'avec des valeurs renseignées.
      // Sinon, les champs que Zotero n'expose pas (notes, keywords, champs
      // BibTeX personnalisés, booktitle en mode local) disparaissaient à la
      // première synchronisation — perte devenue définitive depuis que le
      // .bib du projet est réécrit derrière.
      return createCitation({
        ...local,
        ...definedFields(remote),
        // Champs dont Zotero est propriétaire : la notice distante fait
        // foi, y compris quand elle est vide. Sans cela, un titre court
        // fabriqué par une ancienne version, ou un auteur corrigé en
        // « aucun » dans Zotero, survivaient indéfiniment.
        type: remote.type,
        title: remote.title,
        author: remote.author,
        editor: remote.editor,
        year: remote.year,
        journal: remote.journal,
        publisher: remote.publisher,
        booktitle: remote.booktitle,
        shortTitle: remote.shortTitle,
        // Les tags d'une notice Zotero ne vivent plus dans le champ `tags`
        // du .bib : on le vide. Tags et notes Zotero suivent Zotero quand
        // ils ont été lus, restent sinon.
        tags: remote.tags?.length ? remote.tags : undefined,
        zoteroTags: remote.zoteroTags ?? local.zoteroTags,
        zoteroNotes: remote.zoteroNotes ?? local.zoteroNotes,
        customFields: mergeCustomFields(local.customFields, remote.customFields),
        // La clé locale est celle que l'auteur a écrite dans son texte :
        // une mise à jour de métadonnées ne renomme jamais une citation.
        id: local.id,
        key: local.key,
        zoteroKey: remote.zoteroKey ?? local.zoteroKey,
        file: local.file, // Preserve local PDF path
        zoteroAttachments: this.mergeAttachments(local.zoteroAttachments, remote.zoteroAttachments),
      });
    } else {
      // Keep local but update Zotero metadata
      return createCitation({
        ...local,
        zoteroAttachments: this.mergeAttachments(local.zoteroAttachments, remote.zoteroAttachments),
      });
    }
  }

  /**
   * Merge attachment lists, preserving download status from local
   */
  /**
   * Pièces jointes : la liste suit Zotero, l'état local (PDF téléchargé et
   * son chemin) suit la pièce jointe.
   *
   * `remote` absent signifie que Zotero n'a pas été interrogé sur les
   * pièces jointes — pas qu'elles ont disparu : la liste locale reste. Sans
   * cette distinction, toute entrée modifiée perdait ses PDF, et le chemin
   * d'un PDF déjà téléchargé (`localPath`) n'était de toute façon jamais
   * reporté.
   */
  private mergeAttachments(
    localAttachments: ZoteroAttachmentInfo[] | undefined,
    remoteAttachments: ZoteroAttachmentInfo[] | undefined
  ): ZoteroAttachmentInfo[] | undefined {
    if (remoteAttachments === undefined) return localAttachments;
    const localByKey = new Map((localAttachments ?? []).map((att) => [att.key, att]));
    return remoteAttachments.map((remoteAtt) => {
      const localAtt = localByKey.get(remoteAtt.key);
      return localAtt
        ? { ...remoteAtt, downloaded: localAtt.downloaded, localPath: localAtt.localPath }
        : remoteAtt;
    });
  }

  /**
   * Check if a citation has been indexed (has associated PDFs in database)
   */
  async isCitationIndexed(citation: Citation, indexedPaths: Set<string>): Promise<boolean> {
    if (!citation.file) return false;
    return indexedPaths.has(citation.file);
  }

  /**
   * Validate sync resolution before applying
   */
  validateResolution(resolution: SyncResolution): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

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
  createBackup(citations: Citation[]): string {
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const backupData = JSON.stringify(citations, null, 2);
    return backupData;
  }

  /**
   * Generate a summary report of sync results
   */
  generateSyncReport(result: MergeResult): string {
    const lines: string[] = [];
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
