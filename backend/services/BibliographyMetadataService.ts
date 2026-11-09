import * as fs from 'fs';
import * as path from 'path';
import type { Citation, ZoteroAttachmentInfo, ZoteroNote, ZoteroTag } from '../types/citation';
import { isPdfPath } from '../core/bibliography/pdf-attachment';
import { fromStoredPath, projectCopyOf, toStoredPath } from '../core/bibliography/stored-path';
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
 * Le PDF d'une référence au chargement du projet (S07-2-1) : celui du `.bib` s'il existe, sinon le
 * PDF téléchargé s'il existe (`downloaded`, déjà résolu), sinon celui du `.bib` retrouvé dans
 * `PDFs/` du projet (renommé, ouvert sur un autre Mac) ou depuis la racine du disque ; sinon la
 * valeur d'avant, telle quelle. Un `.bib` abîmé par une ancienne synchronisation (`com apple
 * CloudDocs`, `\textbackslash`) désigne un « PDF » qui ne mène à rien : le PDF téléchargé passe
 * devant. Un chemin qui n'est pas un PDF (instantané HTML) cède toujours devant le PDF téléchargé.
 *
 * Une seule exception à « celui du `.bib` s'il existe » : rangé dans `PDFs/` d'un autre dossier,
 * alors que le téléchargement de la référence dans ce projet est son homonyme de `PDFs/`
 * (`projectCopyOf`). C'est la copie d'un projet écrit avant ce correctif, l'original encore en
 * place : la copie se sert de ses propres PDF. Sans ce téléchargement, rien ne dit que l'homonyme
 * est le sien : le `file` du `.bib` vient aussi d'un import (le `.bib` d'un autre projet, que le
 * parseur résout dans celui-ci), et un homonyme de `PDFs/` est souvent le PDF d'une autre référence
 * (#131). Le PDF du `.bib` garde alors la main.
 */
function resolvePdf(file: string | undefined, downloaded: string | undefined, projectPath: string): string | undefined {
  const fromBib = isPdfPath(file) ? file : undefined;
  const ownCopy = fromBib && downloaded && projectCopyOf(fromBib, projectPath) === downloaded ? downloaded : undefined;
  const candidates: Array<() => string | undefined> = [
    () => ownCopy,
    () => fromBib,
    () => downloaded,
    () => fromBib && fromStoredPath(fromBib, projectPath),
    () => fromBib && fromDiskRoot(fromBib, projectPath),
  ];
  for (const candidate of candidates) {
    const found = candidate();
    if (found && fs.existsSync(found)) return found;
  }
  return fromBib ?? downloaded ?? file;
}

/**
 * Mendeley Desktop sous macOS écrit `:Users/jean/…:pdf`, sans la barre initiale : le parseur le
 * rattache au dossier du `.bib`, qui peut être un sous-dossier du projet (`biblio/refs.bib`). Un
 * chemin relu sous le projet et introuvable se cherche donc aussi depuis la racine du disque, privé
 * tour à tour de chacun de ses dossiers sous le projet, jusqu'au premier qui existe ; jamais réduit
 * au seul nom du fichier. Pas sous Windows, où Mendeley écrit la lettre de lecteur.
 */
function fromDiskRoot(file: string, projectPath: string): string | undefined {
  if (process.platform === 'win32') return undefined;
  const relative = toStoredPath(file, projectPath);
  if (relative === file) return undefined;
  const segments = relative.split('/');
  for (let start = 0; start < segments.length - 1; start++) {
    const candidate = `/${segments.slice(start).join('/')}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
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
   * son PDF : rattaché pendant que la synchronisation lisait Zotero, il était perdu. Elle garde aussi
   * le MD5 déjà signalé de son PDF (`signaledMd5`), que Zotero ne connaît pas.
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
            // Rangé relatif au projet (S07-2-1) ; un ancien chemin absolu l'est aussi, une fois retrouvé.
            const localPath = download.localPath && toStoredPath(fromStoredPath(download.localPath, projectPath), projectPath);
            return { ...att, downloaded: download.downloaded, localPath, signaledMd5: onFile?.signaledMd5 };
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

      // Rangé relatif au projet, qui peut changer de nom ou de machine (S07-2-1).
      const downloaded = { ...attachment, downloaded: true, localPath: toStoredPath(localPath, projectPath) };
      const zoteroAttachments = attachments.some((att) => att.key === attachmentKey)
        ? attachments.map((att) => (att.key === attachmentKey ? downloaded : att))
        : [...attachments, downloaded];
      return { ...current?.citations, [storageKey]: { ...entry, zoteroAttachments } };
    });
    console.log(`✅ Updated metadata for citation: ${storageKey}`);
  }

  /**
   * Le MD5 déjà signalé du PDF de cette pièce jointe, dans les métadonnées lues (`loadMetadata`).
   */
  static signaledMd5(
    metadata: BibliographyMetadataFile | null,
    citation: Pick<Citation, 'id' | 'zoteroKey'>,
    attachmentKey: string
  ): string | undefined {
    const entry = metadata?.citations[this.storageKeyFor(citation)];
    return entry?.zoteroAttachments?.find((att) => att.key === attachmentKey)?.signaledMd5;
  }

  /**
   * Retient les PDF modifiés auxquels l'historien a répondu (réindexés, ou ignorés), chacun avec le
   * MD5 qu'il avait alors, sur sa pièce jointe (Q22) : le bandeau ne les signale plus tant que le
   * fichier ne change pas. Le MD5 de Zotero (`md5`) n'est pas touché. Une pièce jointe que le
   * fichier ne connaît pas n'est pas créée ; sans fichier de métadonnées, rien n'est écrit.
   */
  static async rememberSignaled(
    projectPath: string,
    signaled: Array<{ citation: Pick<Citation, 'id' | 'zoteroKey'>; attachmentKey: string; md5: string }>
  ): Promise<void> {
    if (signaled.length === 0 || this.linkedOutside(projectPath) || !this.hasMetadata(projectPath)) return;

    await this.updateMetadataFile(projectPath, (current) => {
      const citations = { ...current?.citations };
      for (const { citation, attachmentKey, md5 } of signaled) {
        const storageKey = this.storageKeyFor(citation);
        const entry = citations[storageKey];
        if (!entry?.zoteroAttachments?.some((att) => att.key === attachmentKey)) continue;
        citations[storageKey] = {
          ...entry,
          zoteroAttachments: entry.zoteroAttachments.map((att) =>
            att.key === attachmentKey ? { ...att, signaledMd5: md5 } : att
          ),
        };
      }
      return citations;
    });
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
   *
   * Avec `projectPath`, les chemins rangés se résolvent contre le projet tel qu'il est (S07-2-1) :
   * ceux des pièces jointes téléchargées, en absolu, et `file` de chaque référence (`resolvePdf`).
   * Sans lui, rien n'est résolu.
   */
  static mergeCitationsWithMetadata(
    citations: Citation[],
    metadata: BibliographyMetadataFile | null,
    projectPath?: string
  ): Citation[] {
    if (!metadata?.citations && !projectPath) {
      return citations;
    }

    let mergedCount = 0;

    const mergedCitations = citations.map(citation => {
      const citationMeta = metadata?.citations?.[this.storageKeyFor(citation)];

      if (citationMeta) {
        mergedCount++;
        const stored = citationMeta.zoteroAttachments || citation.zoteroAttachments;
        const attachments = projectPath
          ? stored?.map((att) => (att.localPath ? { ...att, localPath: fromStoredPath(att.localPath, projectPath) } : att))
          : stored;
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
          file: projectPath
            ? resolvePdf(citation.file, downloadedAttachment?.localPath, projectPath)
            : isPdfPath(citation.file)
              ? citation.file
              : downloadedAttachment?.localPath ?? citation.file,
        };
      }

      if (!projectPath) return citation;
      const file = resolvePdf(citation.file, undefined, projectPath);
      return file === citation.file ? citation : { ...citation, file };
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
