/**
 * Obsidian vault store (fusion step 2.4b, Path B per ADR 0001).
 *
 * A parallel, self-contained SQLite+FTS5 store for Obsidian notes and their
 * chunks, living at `.cliodeck/v2/obsidian-vectors.db`. Independent of the
 * PDF-centric `VectorStore`/`HNSWVectorStore` so the indexer doesn't need
 * the `PDFDocument` → `SourceDocument` generalisation (that's deferred to
 * Path A with a RAG benchmark).
 *
 * Search: brute-force cosine similarity over all chunk embeddings + FTS5
 * (BM25-scored) lexical search; reciprocal rank fusion to combine. Works
 * up to ~10k chunks (typical vault: ≤ a few thousand). When vaults grow
 * past that, swap the dense side for HNSW — the caller-facing shape
 * stays the same.
 *
 * Embeddings are stored as `Float32Array` bytes in BLOBs; dimension is
 * checked on insert against the configured provider dimension.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface ObsidianChunkRecord {
  id: string;
  noteId: string;
  chunkIndex: number;
  content: string;
  sectionTitle?: string;
  startPosition: number;
  endPosition: number;
}

export interface ObsidianNoteRecord {
  id: string;
  relativePath: string;
  vaultPath: string;
  title: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  wikilinks: string[];
  fileHash: string;
  fileMtime: number;
  indexedAt: string;
}

export interface ObsidianSearchHit {
  chunk: ObsidianChunkRecord;
  note: ObsidianNoteRecord;
  score: number;
  /** Individual signals for debugging / UI tooltip. */
  signals: { dense: number; lexical: number };
}

export interface ObsidianVaultStoreConfig {
  /** Path to the SQLite file. */
  dbPath: string;
  /** Expected embedding dimension; enforced on insert. */
  dimension: number;
}

function floatArrayToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bufferToFloatArray(buf: Buffer): Float32Array {
  // Copy so we don't alias into node's pool memory.
  const copy = Buffer.alloc(buf.byteLength);
  buf.copy(copy);
  return new Float32Array(
    copy.buffer,
    copy.byteOffset,
    copy.byteLength / 4
  );
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export class ObsidianVaultStore {
  private db: Database.Database;
  private readonly dimension: number;

  constructor(cfg: ObsidianVaultStoreConfig) {
    fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
    this.db = new Database(cfg.dbPath);
    this.dimension = cfg.dimension;
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        vault_path TEXT NOT NULL,
        title TEXT NOT NULL,
        tags TEXT NOT NULL,
        frontmatter TEXT NOT NULL,
        wikilinks TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        file_mtime INTEGER NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_hash ON notes(file_hash);
      CREATE INDEX IF NOT EXISTS idx_notes_mtime ON notes(file_mtime);

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        section_title TEXT,
        start_position INTEGER NOT NULL,
        end_position INTEGER NOT NULL,
        embedding BLOB,
        dimension INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_note ON chunks(note_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        id UNINDEXED,
        content,
        tokenize = 'porter unicode61'
      );
    `);
  }

  // MARK: - writes

  upsertNote(note: ObsidianNoteRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO notes (id, relative_path, vault_path, title, tags, frontmatter, wikilinks, file_hash, file_mtime, indexed_at)
      VALUES (@id, @relative_path, @vault_path, @title, @tags, @frontmatter, @wikilinks, @file_hash, @file_mtime, @indexed_at)
      ON CONFLICT(id) DO UPDATE SET
        relative_path = excluded.relative_path,
        vault_path = excluded.vault_path,
        title = excluded.title,
        tags = excluded.tags,
        frontmatter = excluded.frontmatter,
        wikilinks = excluded.wikilinks,
        file_hash = excluded.file_hash,
        file_mtime = excluded.file_mtime,
        indexed_at = excluded.indexed_at
    `);
    stmt.run({
      id: note.id,
      relative_path: note.relativePath,
      vault_path: note.vaultPath,
      title: note.title,
      tags: JSON.stringify(note.tags),
      frontmatter: JSON.stringify(note.frontmatter),
      wikilinks: JSON.stringify(note.wikilinks),
      file_hash: note.fileHash,
      file_mtime: note.fileMtime,
      indexed_at: note.indexedAt,
    });
  }

  deleteNoteChunks(noteId: string): void {
    this.db.prepare('DELETE FROM chunks WHERE note_id = ?').run(noteId);
    this.db
      .prepare(
        'DELETE FROM chunks_fts WHERE id IN (SELECT id FROM chunks WHERE note_id = ?)'
      )
      .run(noteId);
  }

  addChunk(chunk: ObsidianChunkRecord, embedding: Float32Array): void {
    if (embedding.length !== this.dimension) {
      throw new Error(
        `Embedding dimension mismatch: got ${embedding.length}, expected ${this.dimension}`
      );
    }
    // Validate every float before writing — a NaN/Infinity slipping into
    // the BLOB is harmless on insert but poisons any future cosine
    // computation that reads it back, and in one observed case
    // correlated with a SIGSEGV in the native binding on subsequent
    // writes. Throwing here means the batch reports the chunk as
    // failed instead of crashing the indexer for the whole vault.
    for (let i = 0; i < embedding.length; i++) {
      const v = embedding[i];
      if (!Number.isFinite(v)) {
        throw new Error(
          `Embedding for chunk ${chunk.id} contains a non-finite value at index ${i} (${v}); refusing to persist.`
        );
      }
    }
    this.db
      .prepare(
        `INSERT INTO chunks (id, note_id, chunk_index, content, section_title, start_position, end_position, embedding, dimension)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           chunk_index = excluded.chunk_index,
           content = excluded.content,
           section_title = excluded.section_title,
           start_position = excluded.start_position,
           end_position = excluded.end_position,
           embedding = excluded.embedding,
           dimension = excluded.dimension`
      )
      .run(
        chunk.id,
        chunk.noteId,
        chunk.chunkIndex,
        chunk.content,
        chunk.sectionTitle ?? null,
        chunk.startPosition,
        chunk.endPosition,
        floatArrayToBuffer(embedding),
        this.dimension
      );
    // FTS5 virtual tables don't support UPSERT — the indexer guarantees a
    // prior `deleteNoteChunks(noteId)` wipes matching rows first.
    this.db
      .prepare('DELETE FROM chunks_fts WHERE id = ?')
      .run(chunk.id);
    this.db
      .prepare('INSERT INTO chunks_fts (id, content) VALUES (?, ?)')
      .run(chunk.id, chunk.content);
  }

  // MARK: - reads

  getNoteByPath(relativePath: string): ObsidianNoteRecord | null {
    const row = this.db
      .prepare('SELECT * FROM notes WHERE relative_path = ?')
      .get(relativePath) as RawNoteRow | undefined;
    return row ? rowToNote(row) : null;
  }

  getNoteByHash(fileHash: string): ObsidianNoteRecord | null {
    const row = this.db
      .prepare('SELECT * FROM notes WHERE file_hash = ?')
      .get(fileHash) as RawNoteRow | undefined;
    return row ? rowToNote(row) : null;
  }

  stats(): { noteCount: number; chunkCount: number } {
    const n = this.db.prepare('SELECT COUNT(*) AS c FROM notes').get() as {
      c: number;
    };
    const c = this.db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as {
      c: number;
    };
    return { noteCount: n.c, chunkCount: c.c };
  }

  // MARK: - search

  /**
   * Hybrid search: brute-force cosine + FTS5 BM25, combined via reciprocal
   * rank fusion (K=60 — same constant as the PDF HybridSearch so qualitative
   * behaviour matches).
   */
  search(queryEmbedding: Float32Array, queryText: string, topK = 10): ObsidianSearchHit[] {
    const K = 60;

    // Dense: load all chunks that have embeddings, score by cosine.
    const denseRows = this.db
      .prepare(
        `SELECT c.id, c.note_id, c.chunk_index, c.content, c.section_title, c.start_position, c.end_position, c.embedding
         FROM chunks c WHERE c.embedding IS NOT NULL`
      )
      .all() as RawChunkRow[];

    const dense = denseRows
      .map((r) => ({
        id: r.id,
        score: cosine(queryEmbedding, bufferToFloatArray(r.embedding!)),
        row: r,
      }))
      .sort((a, b) => b.score - a.score);

    // Lexical: FTS5 with built-in BM25 scoring (negative rank is better by FTS5 convention).
    let lexical: Array<{ id: string; score: number; row: RawChunkRow | null }> = [];
    if (queryText.trim()) {
      try {
        const ftsRows = this.db
          .prepare(
            `SELECT f.id, bm25(chunks_fts) AS bm
             FROM chunks_fts f
             WHERE chunks_fts MATCH ?
             ORDER BY bm
             LIMIT ?`
          )
          .all(escapeFts(queryText), topK * 4) as Array<{
          id: string;
          bm: number;
        }>;

        const byId = new Map<string, RawChunkRow>();
        if (ftsRows.length) {
          const ids = ftsRows.map((r) => r.id);
          const rows = this.db
            .prepare(
              `SELECT id, note_id, chunk_index, content, section_title, start_position, end_position, embedding
               FROM chunks WHERE id IN (${ids.map(() => '?').join(',')})`
            )
            .all(...ids) as RawChunkRow[];
          for (const r of rows) byId.set(r.id, r);
        }
        lexical = ftsRows.map((r) => ({
          id: r.id,
          score: -r.bm, // negate so higher = better
          row: byId.get(r.id) ?? null,
        }));
      } catch {
        // Malformed FTS query (e.g., stray operators) — fall back to dense-only.
        lexical = [];
      }
    }

    // RRF fusion
    const fused = new Map<
      string,
      { rrf: number; dense: number; lexical: number; row: RawChunkRow }
    >();
    const DENSE_W = 0.6;
    const LEX_W = 0.4;

    dense.slice(0, topK * 4).forEach((d, i) => {
      fused.set(d.id, {
        rrf: DENSE_W * (1 / (K + i + 1)),
        dense: d.score,
        lexical: 0,
        row: d.row,
      });
    });
    lexical.forEach((l, i) => {
      if (!l.row) return;
      const prev = fused.get(l.id);
      const add = LEX_W * (1 / (K + i + 1));
      if (prev) {
        prev.rrf += add;
        prev.lexical = l.score;
      } else {
        fused.set(l.id, { rrf: add, dense: 0, lexical: l.score, row: l.row });
      }
    });

    const ranked = [...fused.values()].sort((a, b) => b.rrf - a.rrf).slice(0, topK);

    // Hydrate notes (lazy; each hit joins to its note).
    const hits: ObsidianSearchHit[] = [];
    const noteStmt = this.db.prepare('SELECT * FROM notes WHERE id = ?');
    for (const r of ranked) {
      const noteRow = noteStmt.get(r.row.note_id) as RawNoteRow | undefined;
      if (!noteRow) continue;
      hits.push({
        chunk: {
          id: r.row.id,
          noteId: r.row.note_id,
          chunkIndex: r.row.chunk_index,
          content: r.row.content,
          sectionTitle: r.row.section_title ?? undefined,
          startPosition: r.row.start_position,
          endPosition: r.row.end_position,
        },
        note: rowToNote(noteRow),
        score: r.rrf,
        signals: { dense: r.dense, lexical: r.lexical },
      });
    }
    return hits;
  }

  /**
   * Lexical-only search (FTS5 BM25). Used by callers that don't have an
   * embedding provider on hand — notably the MCP server tool, which
   * shouldn't depend on a running Ollama just to answer a search query.
   */
  searchLexical(queryText: string, topK = 10): ObsidianSearchHit[] {
    if (!queryText.trim()) return [];
    let rows: Array<{ id: string; bm: number }>;
    try {
      rows = this.db
        .prepare(
          `SELECT f.id, bm25(chunks_fts) AS bm
           FROM chunks_fts f
           WHERE chunks_fts MATCH ?
           ORDER BY bm
           LIMIT ?`
        )
        .all(escapeFts(queryText), topK) as Array<{ id: string; bm: number }>;
    } catch {
      return [];
    }
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const chunkRows = this.db
      .prepare(
        `SELECT id, note_id, chunk_index, content, section_title, start_position, end_position
         FROM chunks WHERE id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids) as RawChunkRow[];
    const byId = new Map<string, RawChunkRow>();
    for (const r of chunkRows) byId.set(r.id, r);

    const noteStmt = this.db.prepare('SELECT * FROM notes WHERE id = ?');
    const hits: ObsidianSearchHit[] = [];
    for (const r of rows) {
      const c = byId.get(r.id);
      if (!c) continue;
      const noteRow = noteStmt.get(c.note_id) as RawNoteRow | undefined;
      if (!noteRow) continue;
      hits.push({
        chunk: {
          id: c.id,
          noteId: c.note_id,
          chunkIndex: c.chunk_index,
          content: c.content,
          sectionTitle: c.section_title ?? undefined,
          startPosition: c.start_position,
          endPosition: c.end_position,
        },
        note: rowToNote(noteRow),
        score: -r.bm,
        signals: { dense: 0, lexical: -r.bm },
      });
    }
    return hits;
  }

  close(): void {
    this.db.close();
  }
}

// MARK: - row helpers

interface RawNoteRow {
  id: string;
  relative_path: string;
  vault_path: string;
  title: string;
  tags: string;
  frontmatter: string;
  wikilinks: string;
  file_hash: string;
  file_mtime: number;
  indexed_at: string;
}

interface RawChunkRow {
  id: string;
  note_id: string;
  chunk_index: number;
  content: string;
  section_title: string | null;
  start_position: number;
  end_position: number;
  embedding: Buffer | null;
}

function rowToNote(r: RawNoteRow): ObsidianNoteRecord {
  return {
    id: r.id,
    relativePath: r.relative_path,
    vaultPath: r.vault_path,
    title: r.title,
    tags: JSON.parse(r.tags) as string[],
    frontmatter: JSON.parse(r.frontmatter) as Record<string, unknown>,
    wikilinks: JSON.parse(r.wikilinks) as string[],
    fileHash: r.file_hash,
    fileMtime: r.file_mtime,
    indexedAt: r.indexed_at,
  };
}

/**
 * Escape FTS5 special tokens so arbitrary user queries don't crash the
 * MATCH expression. Wraps each whitespace-separated token in double quotes.
 */
function escapeFts(q: string): string {
  return q
    .replace(/"/g, '""')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(' ');
}
