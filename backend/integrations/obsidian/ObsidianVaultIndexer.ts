/**
 * ObsidianVaultIndexer (fusion step 2.4b, Path B per ADR 0001).
 *
 * Reads a vault via `ObsidianVaultReader`, parses notes via
 * `ObsidianMarkdownParser`, chunks section-aware, embeds via an
 * `EmbeddingProvider` from the phase 1.3 registry, and stores everything
 * in an independent `ObsidianVaultStore` under `.cliodeck/v2/
 * obsidian-vectors.db`.
 *
 * Returns a typed `VaultScanReport` (step 2.1bis) — partial-success
 * first-class. An unreadable or malformed note doesn't fail the whole
 * indexing; it's recorded in `skipped` or `failed` with a typed reason.
 *
 * Unchanged notes (same file hash) are skipped on incremental runs
 * (`{ force: false }` default). Pass `force: true` to reindex
 * everything (e.g., after switching embedding models).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ObsidianVaultReader } from './ObsidianVaultReader.js';
import { ObsidianMarkdownParser } from './ObsidianMarkdownParser.js';
import type {
  ObsidianChunkRecord,
  ObsidianNoteRecord,
  ObsidianVaultStore,
} from './ObsidianVaultStore.js';
import type { EmbeddingProvider } from '../../core/llm/providers/base.js';
import type { VaultFileEntry, ParsedVaultNote } from '../../types/vault.js';
import {
  emptyReport,
  finalizeReport,
  type VaultScanReport,
} from './scan-report.js';

const CHUNK_CHAR_TARGET = 2000;
const CHUNK_OVERLAP = 200;
const EMBEDDING_BATCH_SIZE = 16;
const MAX_NOTE_BYTES = 2 * 1024 * 1024; // 2 MB — anything larger is almost certainly not a note.

export interface IndexOptions {
  force?: boolean;
  onProgress?: (p: {
    stage: 'scanning' | 'parsing' | 'embedding' | 'complete';
    processed: number;
    total: number;
    message?: string;
  }) => void;
}

export class ObsidianVaultIndexer {
  private readonly reader: ObsidianVaultReader;
  private readonly parser: ObsidianMarkdownParser;
  private readonly store: ObsidianVaultStore;
  private readonly embedder: EmbeddingProvider;

  constructor(
    reader: ObsidianVaultReader,
    store: ObsidianVaultStore,
    embedder: EmbeddingProvider
  ) {
    this.reader = reader;
    this.parser = new ObsidianMarkdownParser();
    this.store = store;
    this.embedder = embedder;
  }

  async indexAll(opts: IndexOptions = {}): Promise<VaultScanReport> {
    const entries = await this.reader.scan();
    const report = emptyReport(this.reader.path);
    const force = opts.force ?? false;

    opts.onProgress?.({
      stage: 'scanning',
      processed: 0,
      total: entries.length,
    });

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const ref = {
        relativePath: entry.relativePath,
        absolutePath: entry.absolutePath,
        fileName: entry.fileName,
      };

      if (entry.size === 0) {
        report.skipped.push({ ref, reason: { kind: 'empty_note' } });
        continue;
      }
      if (entry.size > MAX_NOTE_BYTES) {
        report.skipped.push({
          ref,
          reason: {
            kind: 'oversized',
            sizeBytes: entry.size,
            limit: MAX_NOTE_BYTES,
          },
        });
        continue;
      }

      let content: string;
      try {
        content = fs.readFileSync(entry.absolutePath, 'utf8');
      } catch (e) {
        report.failed.push({
          ref,
          reason: {
            kind: 'io_error',
            message: e instanceof Error ? e.message : String(e),
          },
        });
        continue;
      }

      const hash = this.hashContent(content);

      if (!force) {
        const existing = this.store.getNoteByHash(hash);
        if (existing && existing.relativePath === entry.relativePath) {
          // Unchanged: count as indexed but skip the re-embedding cost.
          const parsed = this.parser.parse(entry.relativePath, content);
          report.indexed.push({ ref, parsed });
          continue;
        }
      }

      let parsed: ParsedVaultNote;
      try {
        parsed = this.parser.parse(entry.relativePath, content);
      } catch (e) {
        report.failed.push({
          ref,
          reason: {
            kind: 'parser_crash',
            message: e instanceof Error ? e.message : String(e),
          },
        });
        continue;
      }

      const noteId = this.pathToId(entry.relativePath);
      const note: ObsidianNoteRecord = {
        id: noteId,
        relativePath: entry.relativePath,
        vaultPath: this.reader.path,
        title: parsed.title,
        tags: parsed.tags,
        frontmatter: parsed.frontmatter,
        wikilinks: parsed.wikilinks.map((w) => w.target),
        fileHash: hash,
        fileMtime: entry.mtime,
        indexedAt: new Date().toISOString(),
      };

      this.store.upsertNote(note);
      this.store.deleteNoteChunks(noteId);

      const chunks = this.chunkNote(noteId, parsed);
      if (chunks.length === 0) {
        report.indexed.push({ ref, parsed });
        continue;
      }

      try {
        const embedded = await this.embedBatched(chunks);
        for (const { chunk, embedding } of embedded) {
          this.store.addChunk(chunk, embedding);
        }
        report.indexed.push({ ref, parsed });
      } catch (e) {
        report.failed.push({
          ref,
          reason: {
            kind: 'io_error',
            message: `Embedding failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          },
        });
      }

      opts.onProgress?.({
        stage: 'embedding',
        processed: i + 1,
        total: entries.length,
        message: entry.fileName,
      });
    }

    opts.onProgress?.({
      stage: 'complete',
      processed: entries.length,
      total: entries.length,
    });
    return finalizeReport(report);
  }

  // MARK: - chunking

  private chunkNote(
    noteId: string,
    parsed: ParsedVaultNote
  ): ObsidianChunkRecord[] {
    const body = parsed.body;
    if (!body) return [];
    const chunks: ObsidianChunkRecord[] = [];

    const sections: Array<{ heading: string; content: string; position: number }> = [];
    if (parsed.headings.length === 0) {
      sections.push({ heading: '', content: body, position: 0 });
    } else {
      if (parsed.headings[0].position > 0) {
        sections.push({
          heading: '',
          content: body.substring(0, parsed.headings[0].position).trim(),
          position: 0,
        });
      }
      for (let i = 0; i < parsed.headings.length; i++) {
        const start = parsed.headings[i].position;
        const end =
          i + 1 < parsed.headings.length
            ? parsed.headings[i + 1].position
            : body.length;
        sections.push({
          heading: parsed.headings[i].text,
          content: body.substring(start, end).trim(),
          position: start,
        });
      }
    }

    let chunkIndex = 0;
    for (const section of sections) {
      if (!section.content) continue;
      if (section.content.length <= CHUNK_CHAR_TARGET) {
        chunks.push({
          id: `${noteId}-${chunkIndex}`,
          noteId,
          chunkIndex,
          content: section.content,
          sectionTitle: section.heading || undefined,
          startPosition: section.position,
          endPosition: section.position + section.content.length,
        });
        chunkIndex++;
        continue;
      }
      let pos = 0;
      while (pos < section.content.length) {
        const end = Math.min(pos + CHUNK_CHAR_TARGET, section.content.length);
        let chunkEnd = end;
        if (end < section.content.length) {
          const lookback = section.content.substring(
            Math.max(0, end - 200),
            end
          );
          const bestBreak = Math.max(
            lookback.lastIndexOf('\n\n'),
            lookback.lastIndexOf('. '),
            lookback.lastIndexOf('! '),
            lookback.lastIndexOf('? ')
          );
          if (bestBreak > 0) chunkEnd = end - lookback.length + bestBreak + 2;
        }
        chunks.push({
          id: `${noteId}-${chunkIndex}`,
          noteId,
          chunkIndex,
          content: section.content.substring(pos, chunkEnd).trim(),
          sectionTitle: section.heading || undefined,
          startPosition: section.position + pos,
          endPosition: section.position + chunkEnd,
        });
        chunkIndex++;
        pos = chunkEnd - CHUNK_OVERLAP;
        if (pos <= 0 || chunkEnd >= section.content.length) break;
      }
    }
    return chunks;
  }

  // MARK: - embed

  private async embedBatched(
    chunks: ObsidianChunkRecord[]
  ): Promise<Array<{ chunk: ObsidianChunkRecord; embedding: Float32Array }>> {
    const out: Array<{ chunk: ObsidianChunkRecord; embedding: Float32Array }> = [];
    for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
      const vectors = await this.embedder.embed(batch.map((c) => c.content));
      for (let j = 0; j < batch.length; j++) {
        out.push({ chunk: batch[j], embedding: Float32Array.from(vectors[j]) });
      }
    }
    return out;
  }

  private hashContent(c: string): string {
    return crypto.createHash('sha256').update(c).digest('hex');
  }

  private pathToId(p: string): string {
    return crypto.createHash('md5').update(p).digest('hex');
  }
}

// MARK: - factory helpers

export function obsidianStorePath(workspaceRoot: string): string {
  return path.join(
    workspaceRoot,
    '.cliodeck',
    'v2',
    'obsidian-vectors.db'
  );
}
