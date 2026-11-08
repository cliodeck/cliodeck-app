import * as fs from 'fs';
import * as path from 'path';
import type { Citation, ZoteroAttachmentInfo, ZoteroNote, ZoteroTag } from '../types/citation';
import { isPdfPath } from '../core/bibliography/pdf-attachment';
import { workspaceLinkOutsideSync } from '../core/workspace/link-guard';
import { atomicWriteFile, parseUserJson, readUserFile, withFileLock } from '../core/fs/user-files';

/**
 * Metadata stored for each citation (data that can't be stored in BibTeX)
 */
export interface CitationMetadata {
  id: string; // BibTeX key
  zoteroKey?: string;
  zoteroAttachments?: ZoteroAttachmentInfo[];
  /** Tags Zotero : données de Zotero, gardées hors du .bib, qui voyage. */
  zoteroTags?: ZoteroTag[];
  /** Notes Zotero, en texte. */
  zoteroNotes?: ZoteroNote[];
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
 * Le fichier de métadonnées est là, mais ne se lit pas (JSON tronqué par un conflit de
 * synchronisation, édition à la main) : ce n'est pas un fichier absent. Le prendre pour tel ferait
 * repartir la synchronisation Zotero sans les rattachements de PDF, puis réécrire le fichier, que
 * l'historien aurait pu réparer (S07-1-10).
 */
export class MetadataUnreadableError extends Error {
  readonly code = 'metadata-unreadable';
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(message);
    this.name = 'MetadataUnreadableError';
    this.filePath = filePath;
  }
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
   * `.cliodeck`, ou ce fichier lui-même, lié hors du projet (D18) : ce fichier serait celui d'un
   * autre projet. Rien ne s'y lit ni ne s'y écrit ; l'ouverture du projet l'a dit à l'écran.
   */
  private static linkedOutside(projectPath: string): boolean {
    const entry = workspaceLinkOutsideSync(projectPath);
    if (entry) console.warn('⚠️ Métadonnées bibliographiques ignorées, lien hors du projet :', entry);
    return entry !== null;
  }

  /**
   * Get the path to the metadata file for a project
   */
  static getMetadataPath(projectPath: string): string {
    return path.join(projectPath, '.cliodeck', BibliographyMetadataService.METADATA_FILENAME);
  }

  /** Ce que le fichier garde d'une référence : ce que le `.bib` ne porte pas. */
  private static metadataOf(
    citation: Pick<Citation, 'id' | 'zoteroKey' | 'zoteroAttachments' | 'zoteroTags' | 'zoteroNotes' | 'dateAdded' | 'dateModified'>
  ): CitationMetadata {
    return {
      id: citation.id,
      zoteroKey: citation.zoteroKey,
      zoteroAttachments: citation.zoteroAttachments,
      zoteroTags: citation.zoteroTags,
      zoteroNotes: citation.zoteroNotes,
      dateAdded: citation.dateAdded,
      dateModified: citation.dateModified,
    };
  }

  /**
   * Relit le fichier, le change et le réécrit, un écrivain à la fois : chacun part de ce qu'a
   * écrit le précédent. `.cliodeck` est créé avant le verrou, dont la clé est le chemin réel du
   * fichier. Illisible : `MetadataUnreadableError`, et rien n'est écrit, ni fichier neuf ni mise
   * de côté : l'historien le répare ou en remet une copie (L05-3).
   */
  private static updateMetadataFile(
    projectPath: string,
    change: (current: BibliographyMetadataFile | null) => Record<string, CitationMetadata>
  ): Promise<Record<string, CitationMetadata>> {
    const metadataPath = this.getMetadataPath(projectPath);
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    return withFileLock(metadataPath, async () => {
      const citations = change(await this.loadMetadata(projectPath));
      const metadataFile: BibliographyMetadataFile = {
        version: this.CURRENT_VERSION,
        lastUpdated: new Date().toISOString(),
        citations,
      };
      await atomicWriteFile(metadataPath, JSON.stringify(metadataFile, null, 2));
      return citations;
    });
  }

  /**
   * Ce que la synchronisation Zotero a lu, écrit sur le fichier tel qu'il est au moment d'écrire
   * (S07-1-6). Entrées, pièces jointes, tags, notes et dates viennent de la synchronisation, et une
   * entrée qu'elle a retirée part ; mais une pièce jointe que le fichier relu dit téléchargée garde
   * son PDF : rattaché pendant que la synchronisation lisait Zotero, il était perdu.
   */
  static async saveFromSync(projectPath: string, citations: Citation[]): Promise<void> {
    if (this.linkedOutside(projectPath)) return;

    const written = await this.updateMetadataFile(projectPath, (current) => {
      // Index by zoteroKey (unique per Zotero item) when present; fall back
      // to id (bibtexKey) for non-Zotero entries.
      const citationMetadata: Record<string, CitationMetadata> = {};
      for (const citation of citations) {
        // Only save if there's metadata worth saving
        if (!citation.zoteroKey && !citation.zoteroAttachments?.length) continue;
        const storageKey = this.storageKeyFor(citation);
        const onDisk = new Map((current?.citations[storageKey]?.zoteroAttachments ?? []).map((att) => [att.key, att]));
        citationMetadata[storageKey] = {
          ...this.metadataOf(citation),
          zoteroAttachments: citation.zoteroAttachments?.map((att) => {
            const onFile = onDisk.get(att.key);
            const download = onFile?.downloaded && onFile.localPath ? onFile : att;
            return { ...att, downloaded: download.downloaded, localPath: download.localPath };
          }),
        };
      }
      return citationMetadata;
    });
    console.log(`✅ Bibliography metadata saved: ${Object.keys(written).length} citations with metadata`);
  }

  /**
   * Rattache un PDF téléchargé à sa pièce jointe, et rien d'autre (S07-1-5) : le reste du fichier
   * est celui du disque, pas la liste du renderer, prise avant le téléchargement, avec laquelle
   * deux téléchargements simultanés s'effaçaient. L'entrée manquante est créée depuis `citation`.
   */
  static async patchAttachment(
    projectPath: string,
    citation: Pick<Citation, 'id' | 'zoteroKey' | 'zoteroAttachments' | 'zoteroTags' | 'zoteroNotes' | 'dateAdded' | 'dateModified'>,
    attachmentKey: string,
    localPath: string
  ): Promise<void> {
    if (this.linkedOutside(projectPath)) return;
    const storageKey = this.storageKeyFor(citation);

    await this.updateMetadataFile(projectPath, (current) => {
      const entry = current?.citations[storageKey] ?? this.metadataOf(citation);
      const attachments = entry.zoteroAttachments ?? [];
      const attachment =
        attachments.find((att) => att.key === attachmentKey) ??
        citation.zoteroAttachments?.find((att) => att.key === attachmentKey);
      if (!attachment) throw new Error(`Pièce jointe ${attachmentKey} inconnue de la référence ${citation.id}`);

      const downloaded = { ...attachment, downloaded: true, localPath };
      const zoteroAttachments = attachments.some((att) => att.key === attachmentKey)
        ? attachments.map((att) => (att.key === attachmentKey ? downloaded : att))
        : [...attachments, downloaded];
      return { ...current?.citations, [storageKey]: { ...entry, zoteroAttachments } };
    });
    console.log(`✅ Updated metadata for citation: ${storageKey}`);
  }

  /**
   * Load metadata from file. Absent : `null`. Illisible, JSON invalide ou qui n'est pas un fichier
   * de métadonnées : `MetadataUnreadableError`, jamais `null`.
   */
  static async loadMetadata(projectPath: string): Promise<BibliographyMetadataFile | null> {
    if (this.linkedOutside(projectPath)) return null;
    const metadataPath = this.getMetadataPath(projectPath);

    const read = await readUserFile(metadataPath);
    if (read.kind === 'absent') {
      console.log('📂 No bibliography metadata file found');
      return null;
    }
    if (read.kind === 'unreadable') throw new MetadataUnreadableError(metadataPath, read.message);

    let metadata: BibliographyMetadataFile;
    try {
      metadata = parseUserJson<BibliographyMetadataFile>(read.content);
    } catch (error) {
      throw new MetadataUnreadableError(metadataPath, error instanceof Error ? error.message : String(error));
    }
    const citations: unknown = (metadata as { citations?: unknown } | null)?.citations;
    if (typeof citations !== 'object' || citations === null || Array.isArray(citations)) {
      throw new MetadataUnreadableError(metadataPath, `${metadataPath} n'est pas un fichier de métadonnées bibliographiques`);
    }

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
        const attachments = citationMeta.zoteroAttachments || citation.zoteroAttachments;
        // Derive citation.file from a previously-downloaded Zotero attachment
        // when the BibTeX entry carries no `file =` field. Without this, a
        // citation that was first indexed via the Zotero download flow comes
        // back without a `file` after a reload — the renderer sees
        // `hasPDF === false`, and the re-index button throws "No PDF file
        // associated with this citation". A PDF path given by the BibTeX entry
        // always wins; a path that is not a PDF (an HTML snapshot attached by
        // an older Zotero sync) yields to the downloaded PDF — otherwise the
        // download would be forgotten at every reload.
        const downloadedAttachment = attachments?.find(
          (a) => a.downloaded && a.localPath,
        );
        return {
          ...citation,
          zoteroKey: citationMeta.zoteroKey || citation.zoteroKey,
          zoteroAttachments: attachments,
          zoteroTags: citationMeta.zoteroTags ?? citation.zoteroTags,
          zoteroNotes: citationMeta.zoteroNotes ?? citation.zoteroNotes,
          dateAdded: citationMeta.dateAdded || citation.dateAdded,
          dateModified: citationMeta.dateModified || citation.dateModified,
          file: isPdfPath(citation.file)
            ? citation.file
            : downloadedAttachment?.localPath ?? citation.file,
        };
      }

      return citation;
    });

    console.log(`🔗 Merged metadata into ${mergedCount} citations`);
    return mergedCitations;
  }

  /**
   * Check if metadata file exists for a project
   */
  static hasMetadata(projectPath: string): boolean {
    return fs.existsSync(this.getMetadataPath(projectPath));
  }
}
