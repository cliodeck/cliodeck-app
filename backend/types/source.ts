/**
 * Unified Source type — fusion ClioBrain/ClioDeck (step 0.4).
 *
 * A `Source` is any ingestable item: a local file, a Zotero/Tropy record,
 * a folder, or an Obsidian note. Specializations are expressed via a
 * discriminated union on `type` so consumers can narrow safely.
 */

export type SourceType =
  | 'file'
  | 'zotero'
  | 'tropy'
  | 'folder'
  | 'obsidian-note';

export interface SourceBase {
  id: string;
  path: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface FileSource extends SourceBase {
  type: 'file';
  metadata: {
    filename?: string;
    mimeType?: string;
    sizeBytes?: number;
    pageCount?: number;
    [k: string]: unknown;
  };
}

export interface FolderSource extends SourceBase {
  type: 'folder';
  metadata: {
    itemCount?: number;
    recursive?: boolean;
    [k: string]: unknown;
  };
}

export interface ZoteroSource extends SourceBase {
  type: 'zotero';
  metadata: {
    itemKey: string;
    libraryId?: number;
    title?: string;
    authors?: string;
    year?: string;
    itemType?: string;
    collectionKey?: string;
    attachmentKey?: string;
    [k: string]: unknown;
  };
}

export interface TropySource extends SourceBase {
  type: 'tropy';
  metadata: {
    itemId: string;
    projectPath?: string;
    title?: string;
    photoCount?: number;
    tags?: string[];
    [k: string]: unknown;
  };
}

export interface ObsidianNoteSource extends SourceBase {
  type: 'obsidian-note';
  metadata: {
    vaultPath: string;
    notePath: string;
    title?: string;
    tags?: string[];
    frontmatter?: Record<string, unknown>;
    wikilinks?: string[];
    [k: string]: unknown;
  };
}

export type Source =
  | FileSource
  | FolderSource
  | ZoteroSource
  | TropySource
  | ObsidianNoteSource;

export type SourceId = string;

export function isSourceType<T extends SourceType>(
  source: Source,
  type: T
): source is Extract<Source, { type: T }> {
  return source.type === type;
}
