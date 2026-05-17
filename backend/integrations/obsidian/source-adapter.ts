/**
 * Obsidian → unified `Source` adapter (fusion step 2.1).
 *
 * Bridges the legacy ClioBrain vault types (`VaultFileEntry`,
 * `ParsedVaultNote`) to the unified `Source` discriminated union defined in
 * step 0.4, so the rest of the backend (RAG, recipes, MCP tools) treats
 * Obsidian notes identically to files / Zotero / Tropy items.
 */

import path from 'path';
import type {
  ParsedVaultNote,
  VaultFileEntry,
} from '../../types/vault.js';
import type { ObsidianNoteSource } from '../../types/source.js';

export interface ToSourceOptions {
  vaultPath: string;
  /** Stable id scheme. Default: `obsidian:<relativePath>`. */
  idFn?: (note: Pick<VaultFileEntry, 'relativePath'>) => string;
}

function defaultId(relativePath: string): string {
  return `obsidian:${relativePath}`;
}

export function entryToSource(
  entry: VaultFileEntry,
  opts: ToSourceOptions
): ObsidianNoteSource {
  const id = opts.idFn?.(entry) ?? defaultId(entry.relativePath);
  return {
    id,
    type: 'obsidian-note',
    path: entry.absolutePath,
    createdAt: undefined,
    updatedAt: new Date(entry.mtime).toISOString(),
    metadata: {
      vaultPath: opts.vaultPath,
      notePath: entry.relativePath,
      title: path.basename(entry.relativePath, path.extname(entry.relativePath)),
      sizeBytes: entry.size,
    },
  };
}

export function parsedNoteToSource(
  note: ParsedVaultNote,
  opts: ToSourceOptions
): ObsidianNoteSource {
  const id = opts.idFn?.({ relativePath: note.relativePath }) ?? defaultId(note.relativePath);
  return {
    id,
    type: 'obsidian-note',
    path: path.join(opts.vaultPath, note.relativePath),
    metadata: {
      vaultPath: opts.vaultPath,
      notePath: note.relativePath,
      title: note.title,
      tags: note.tags,
      frontmatter: note.frontmatter,
      wikilinks: note.wikilinks.map((w) => w.target),
    },
  };
}
