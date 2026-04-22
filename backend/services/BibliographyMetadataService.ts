import * as fs from 'fs';
import * as path from 'path';
import type { Citation, ZoteroAttachmentInfo } from '../types/citation';

/**
 * Metadata stored for each citation (data that can't be stored in BibTeX)
 */
export interface CitationMetadata {
  id: string; // BibTeX key
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
 *
 * Storage key: `zoteroKey` when present, `id` (bibtexKey) as fallback.
 * Reason: Zotero's "Better BibTeX" export often collides bibtexKeys across
 * many items (e.g. 68 diary entries all exported as `Lester_1935/1936`).
 * Indexing by bibtexKey would make all but one citation lose their
 * attachments. zoteroKey is guaranteed unique per Zotero item.
 */
export class BibliographyMetadataService {
  private static readonly METADATA_FILENAME = 'bibliography-metadata.json';
  private static readonly CURRENT_VERSION = 2;

  /**
   * Storage key for a citation's metadata row.
   * Use zoteroKey when present (unique per Zotero item), fall back to
   * bibtexKey (`id`) for non-Zotero citations.
   */
  private static storageKeyFor(citation: Pick<Citation, 'id' | 'zoteroKey'>): string {
    return citation.zoteroKey || citation.id;
  }

  private static storageKeyFromMeta(meta: CitationMetadata): string {
    return meta.zoteroKey || meta.id;
  }

  /**
   * Get the path to the metadata file for a project
   */
  static getMetadataPath(projectPath: string): string {
    return path.join(projectPath, '.cliodeck', BibliographyMetadataService.METADATA_FILENAME);
  }

  /**
   * Save metadata for citations
   * Only saves metadata that can't be stored in BibTeX (zoteroAttachments, etc.)
   */
  static async saveMetadata(projectPath: string, citations: Citation[]): Promise<void> {
    const metadataPath = this.getMetadataPath(projectPath);
    const metadataDir = path.dirname(metadataPath);

    // Ensure .cliodeck directory exists
    if (!fs.existsSync(metadataDir)) {
      fs.mkdirSync(metadataDir, { recursive: true });
    }

    // Extract metadata from citations. Index by zoteroKey (unique per Zotero
    // item) when present; fall back to id (bibtexKey) for non-Zotero entries.
    const citationMetadata: Record<string, CitationMetadata> = {};

    for (const citation of citations) {
      // Only save if there's metadata worth saving
      if (citation.zoteroKey || citation.zoteroAttachments?.length) {
        const storageKey = this.storageKeyFor(citation);
        citationMetadata[storageKey] = {
          id: citation.id,
          zoteroKey: citation.zoteroKey,
          zoteroAttachments: citation.zoteroAttachments,
          dateAdded: citation.dateAdded,
          dateModified: citation.dateModified,
        };
      }
    }

    const metadataFile: BibliographyMetadataFile = {
      version: this.CURRENT_VERSION,
      lastUpdated: new Date().toISOString(),
      citations: citationMetadata,
    };

    // Write atomically (write to temp, then rename)
    const tempPath = metadataPath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(metadataFile, null, 2), 'utf-8');
    fs.renameSync(tempPath, metadataPath);

    console.log(`✅ Bibliography metadata saved: ${Object.keys(citationMetadata).length} citations with metadata`);
  }

  /**
   * Load metadata from file
   */
  static async loadMetadata(projectPath: string): Promise<BibliographyMetadataFile | null> {
    const metadataPath = this.getMetadataPath(projectPath);

    if (!fs.existsSync(metadataPath)) {
      console.log('📂 No bibliography metadata file found');
      return null;
    }

    try {
      const content = fs.readFileSync(metadataPath, 'utf-8');
      const metadata = JSON.parse(content) as BibliographyMetadataFile;

      // v1 → v2 migration: re-index entries by zoteroKey when present so
      // bibtexKey collisions stop dropping attachments at the first match.
      if (metadata.version === 1) {
        const reIndexed: Record<string, CitationMetadata> = {};
        for (const entry of Object.values(metadata.citations)) {
          reIndexed[this.storageKeyFromMeta(entry)] = entry;
        }
        metadata.version = this.CURRENT_VERSION;
        metadata.citations = reIndexed;
        console.log(
          `🔄 Migrated bibliography metadata v1 → v${this.CURRENT_VERSION}: ${Object.keys(reIndexed).length} entries re-indexed by zoteroKey. ` +
            `Any attachments lost to bibtexKey collisions in v1 need a fresh Zotero sync to recover.`
        );
      } else if (metadata.version !== this.CURRENT_VERSION) {
        console.log(`⚠️ Metadata version mismatch: ${metadata.version} vs ${this.CURRENT_VERSION}`);
      }

      console.log(`✅ Bibliography metadata loaded: ${Object.keys(metadata.citations).length} entries`);
      return metadata;
    } catch (error) {
      console.error('❌ Failed to load bibliography metadata:', error);
      return null;
    }
  }

  /**
   * Merge metadata into citations
   * This is called when loading a bibliography to restore Zotero-specific data
   */
  static mergeCitationsWithMetadata(citations: Citation[], metadata: BibliographyMetadataFile | null): Citation[] {
    if (!metadata || !metadata.citations) {
      return citations;
    }

    let mergedCount = 0;

    const mergedCitations = citations.map(citation => {
      const citationMeta = metadata.citations[this.storageKeyFor(citation)];

      if (citationMeta) {
        mergedCount++;
        return {
          ...citation,
          zoteroKey: citationMeta.zoteroKey || citation.zoteroKey,
          zoteroAttachments: citationMeta.zoteroAttachments || citation.zoteroAttachments,
          dateAdded: citationMeta.dateAdded || citation.dateAdded,
          dateModified: citationMeta.dateModified || citation.dateModified,
        };
      }

      return citation;
    });

    console.log(`🔗 Merged metadata into ${mergedCount} citations`);
    return mergedCitations;
  }

  /**
   * Update metadata for a specific citation (partial update).
   * Useful when downloading a single PDF.
   *
   * `storageKey` is the citation's zoteroKey when available, otherwise
   * its bibtexKey (`id`). Callers should pass whichever key they have —
   * but if they have a zoteroKey, they MUST pass that, or the entry will
   * land in the wrong row (colliding with any bibtexKey twin).
   */
  static async updateCitationMetadata(
    projectPath: string,
    storageKey: string,
    updates: Partial<CitationMetadata>
  ): Promise<void> {
    const existingMetadata = await this.loadMetadata(projectPath);

    const metadata: BibliographyMetadataFile = existingMetadata || {
      version: this.CURRENT_VERSION,
      lastUpdated: new Date().toISOString(),
      citations: {},
    };

    // Merge updates
    metadata.citations[storageKey] = {
      ...metadata.citations[storageKey],
      id: updates.id ?? metadata.citations[storageKey]?.id ?? storageKey,
      ...updates,
    };

    metadata.lastUpdated = new Date().toISOString();

    // Save
    const metadataPath = this.getMetadataPath(projectPath);
    const metadataDir = path.dirname(metadataPath);

    if (!fs.existsSync(metadataDir)) {
      fs.mkdirSync(metadataDir, { recursive: true });
    }

    const tempPath = metadataPath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(metadata, null, 2), 'utf-8');
    fs.renameSync(tempPath, metadataPath);

    console.log(`✅ Updated metadata for citation: ${storageKey}`);
  }

  /**
   * Check if metadata file exists for a project
   */
  static hasMetadata(projectPath: string): boolean {
    return fs.existsSync(this.getMetadataPath(projectPath));
  }
}
