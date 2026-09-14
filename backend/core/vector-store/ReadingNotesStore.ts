/**
 * Store du corpus « notes de lecture ».
 *
 * Cinquième corpus RAG : les fichiers `reading-notes/<clé>.md` du projet, où
 * l'historien consigne ce qu'il pense d'une référence. Ce n'est ni la source
 * (le PDF, corpus secondaire) ni son propre texte (le manuscrit) : c'est son
 * commentaire d'une source, et l'assistant doit le présenter comme tel.
 *
 * Calqué sur `ManuscriptStore`, délibérément : tables préfixées
 * `reading_notes_` dans le `.cliodeck/brain.db` partagé, embeddings en BLOB
 * `Float32Array`, recherche hybride cosinus + FTS5 BM25 fusionnée par RRF
 * (K=60, mêmes poids), signaux bruts publiés pour le contrat de pertinence
 * commun (Path A′). Aucune clé nouvelle dans `workspace/layout.ts`.
 *
 * Unité indexée : la **note**, identifiée par sa référence (`zotero:<clé>`,
 * sinon `citekey:<clé>`) et non par son chemin — renommer le fichier à la
 * main ne doit ni dupliquer ni réembarquer la note.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface ReadingNoteChunkRecord {
  id: string;
  noteId: string;
  chunkIndex: number;
  /** Texte de l'extrait, tel qu'écrit dans la note. */
  content: string;
  sectionTitle?: string;
  /** Ligne 1-indexée dans le fichier, pour ramener l'auteur à sa note. */
  line: number;
}

export interface ReadingNoteRecord {
  /** `zotero:<clé>` ou `citekey:<clé>`. */
  id: string;
  /** Chemin relatif au projet (`reading-notes/Braudel_1949.md`). */
  relativePath: string;
  citekey: string;
  zoteroKey?: string;
  /** Titre de la référence, repris du front matter. */
  title?: string;
  /** Étiquettes du projet. */
  tags: string[];
  /** Empreinte du fichier entier : porte l'incrémental. */
  contentHash: string;
  indexedAt: string;
}

export interface ReadingNoteSearchHit {
  chunk: ReadingNoteChunkRecord;
  note: ReadingNoteRecord;
  /** Score RRF : choisit les extraits, ne se compare pas d'un corpus à l'autre. */
  score: number;
  /** Signaux bruts pour `relevanceScore` (`backend/core/rag/relevance.ts`). */
  signals: { dense: number; lexical: number; lexicalRank: number | null };
}

export interface ReadingNotesStoreConfig {
  dbPath: string;
  /** Verrouillée sur le premier `addChunk` si omise (cf. `ManuscriptStore`). */
  dimension?: number;
}

function floatArrayToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bufferToFloatArray(buf: Buffer): Float32Array {
  const copy = Buffer.alloc(buf.byteLength);
  buf.copy(copy);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
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

/** Échappe les tokens FTS5 pour qu'une requête libre ne casse pas le MATCH. */
function escapeFts(q: string): string {
  return q
    .replace(/"/g, '""')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(' ');
}

/**
 * En-tête d'une note : ce qui la rattache à sa référence.
 *
 * Embarqué et indexé avec chaque extrait, pour que « Braudel », une clé de
 * citation ou une étiquette du projet retrouvent la note même quand le corps
 * ne les répète pas — ce qui est la règle dans une note de lecture.
 */
export function readingNoteHeader(note: Pick<ReadingNoteRecord, 'citekey' | 'title' | 'tags'>): string {
  const parts = [`Note de lecture sur @${note.citekey}`];
  if (note.title) parts.push(note.title);
  const head = parts.join(' — ');
  return note.tags.length ? `${head}\nÉtiquettes : ${note.tags.join(', ')}` : head;
}

export class ReadingNotesStore {
  private db: Database.Database;
  private dimension: number | null;

  constructor(cfg: ReadingNotesStoreConfig) {
    fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
    this.db = new Database(cfg.dbPath);
    this.dimension = cfg.dimension ?? null;
    this.db.pragma('journal_mode = WAL');
    // `brain.db` a plusieurs writers : sans busy_timeout, une écriture
    // concurrente échoue immédiatement sur SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');
    // Sans cela, `ON DELETE CASCADE` est lettre morte dans SQLite.
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  /** Empreinte et extraits d'une note s'écrivent tout ou rien (cf. `ManuscriptStore`). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reading_notes (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        citekey TEXT NOT NULL,
        zotero_key TEXT,
        title TEXT,
        tags TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reading_notes_chunks (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL REFERENCES reading_notes(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        section_title TEXT,
        line INTEGER NOT NULL,
        embedding BLOB,
        dimension INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reading_notes_chunks_note
        ON reading_notes_chunks(note_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS reading_notes_chunks_fts USING fts5(
        id UNINDEXED,
        content,
        tokenize = 'porter unicode61'
      );
    `);
  }

  // MARK: - writes

  upsertNote(note: ReadingNoteRecord): void {
    this.db
      .prepare(
        `INSERT INTO reading_notes (id, relative_path, citekey, zotero_key, title, tags, content_hash, indexed_at)
         VALUES (@id, @relative_path, @citekey, @zotero_key, @title, @tags, @content_hash, @indexed_at)
         ON CONFLICT(id) DO UPDATE SET
           relative_path = excluded.relative_path,
           citekey = excluded.citekey,
           zotero_key = excluded.zotero_key,
           title = excluded.title,
           tags = excluded.tags,
           content_hash = excluded.content_hash,
           indexed_at = excluded.indexed_at`
      )
      .run({
        id: note.id,
        relative_path: note.relativePath,
        citekey: note.citekey,
        zotero_key: note.zoteroKey ?? null,
        title: note.title ?? null,
        tags: JSON.stringify(note.tags),
        content_hash: note.contentHash,
        indexed_at: note.indexedAt,
      });
  }

  deleteNoteChunks(noteId: string): void {
    this.db
      .prepare(
        'DELETE FROM reading_notes_chunks_fts WHERE id IN (SELECT id FROM reading_notes_chunks WHERE note_id = ?)'
      )
      .run(noteId);
    this.db.prepare('DELETE FROM reading_notes_chunks WHERE note_id = ?').run(noteId);
  }

  /** Retire une note et ses extraits (fichier supprimé). */
  deleteNote(noteId: string): void {
    this.deleteNoteChunks(noteId);
    this.db.prepare('DELETE FROM reading_notes WHERE id = ?').run(noteId);
  }

  /**
   * Écrit un extrait. `header` (cf. `readingNoteHeader`) est indexé en plein
   * texte avec lui, mais n'est pas stocké dans `content` : l'extrait rendu à
   * l'assistant reste le texte de l'auteur.
   */
  addChunk(chunk: ReadingNoteChunkRecord, embedding: Float32Array, header = ''): void {
    this.dimension ??= embedding.length;
    if (embedding.length !== this.dimension) {
      throw new Error(`Embedding dimension mismatch: got ${embedding.length}, expected ${this.dimension}`);
    }
    for (let i = 0; i < embedding.length; i++) {
      if (!Number.isFinite(embedding[i])) {
        throw new Error(
          `Embedding for chunk ${chunk.id} contains a non-finite value at index ${i}; refusing to persist.`
        );
      }
    }
    this.db
      .prepare(
        `INSERT INTO reading_notes_chunks (id, note_id, chunk_index, content, section_title, line, embedding, dimension)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           note_id = excluded.note_id,
           chunk_index = excluded.chunk_index,
           content = excluded.content,
           section_title = excluded.section_title,
           line = excluded.line,
           embedding = excluded.embedding,
           dimension = excluded.dimension`
      )
      .run(
        chunk.id,
        chunk.noteId,
        chunk.chunkIndex,
        chunk.content,
        chunk.sectionTitle ?? null,
        chunk.line,
        floatArrayToBuffer(embedding),
        this.dimension
      );
    // FTS5 ne connaît pas l'UPSERT : on efface avant d'insérer.
    this.db.prepare('DELETE FROM reading_notes_chunks_fts WHERE id = ?').run(chunk.id);
    this.db
      .prepare('INSERT INTO reading_notes_chunks_fts (id, content) VALUES (?, ?)')
      .run(chunk.id, header ? `${header}\n\n${chunk.content}` : chunk.content);
  }

  // MARK: - reads

  getNote(noteId: string): ReadingNoteRecord | null {
    const row = this.db.prepare('SELECT * FROM reading_notes WHERE id = ?').get(noteId) as RawNoteRow | undefined;
    return row ? rowToNote(row) : null;
  }

  listNotes(): ReadingNoteRecord[] {
    const rows = this.db.prepare('SELECT * FROM reading_notes ORDER BY citekey').all() as RawNoteRow[];
    return rows.map(rowToNote);
  }

  stats(): { noteCount: number; chunkCount: number; lastIndexedAt: string | null } {
    const notes = this.db.prepare('SELECT COUNT(*) AS c FROM reading_notes').get() as { c: number };
    const chunks = this.db.prepare('SELECT COUNT(*) AS c FROM reading_notes_chunks').get() as { c: number };
    const last = this.db.prepare('SELECT MAX(indexed_at) AS t FROM reading_notes').get() as { t: string | null };
    return { noteCount: notes.c, chunkCount: chunks.c, lastIndexedAt: last.t ?? null };
  }

  // MARK: - search

  private lexicalIds(queryText: string, limit: number): Array<{ id: string; bm: number }> {
    if (!queryText.trim()) return [];
    try {
      return this.db
        .prepare(
          `SELECT f.id, bm25(reading_notes_chunks_fts) AS bm
           FROM reading_notes_chunks_fts f
           WHERE reading_notes_chunks_fts MATCH ?
           ORDER BY bm
           LIMIT ?`
        )
        .all(escapeFts(queryText), limit) as Array<{ id: string; bm: number }>;
    } catch {
      return [];
    }
  }

  private chunkRows(ids: string[]): Map<string, RawChunkRow> {
    const byId = new Map<string, RawChunkRow>();
    if (!ids.length) return byId;
    const rows = this.db
      .prepare(
        `SELECT id, note_id, chunk_index, content, section_title, line, embedding
         FROM reading_notes_chunks WHERE id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids) as RawChunkRow[];
    for (const r of rows) byId.set(r.id, r);
    return byId;
  }

  /** Recherche hybride : cosinus + BM25, fusion RRF (K=60), comme les autres corpus. */
  search(queryEmbedding: Float32Array, queryText: string, topK = 10): ReadingNoteSearchHit[] {
    const K = 60;
    const DENSE_W = 0.6;
    const LEX_W = 0.4;

    const denseRows = this.db
      .prepare(
        `SELECT id, note_id, chunk_index, content, section_title, line, embedding
         FROM reading_notes_chunks WHERE embedding IS NOT NULL`
      )
      .all() as RawChunkRow[];
    const dense = denseRows
      .map((r) => ({ id: r.id, score: cosine(queryEmbedding, bufferToFloatArray(r.embedding!)), row: r }))
      .sort((a, b) => b.score - a.score);

    const ftsRows = this.lexicalIds(queryText, topK * 4);
    const lexRows = this.chunkRows(ftsRows.map((r) => r.id));

    const fused = new Map<
      string,
      { rrf: number; dense: number; lexical: number; lexicalRank: number | null; row: RawChunkRow }
    >();
    const cosineById = new Map(dense.map((d) => [d.id, d.score]));
    dense.slice(0, topK * 4).forEach((d, i) => {
      fused.set(d.id, { rrf: DENSE_W * (1 / (K + i + 1)), dense: d.score, lexical: 0, lexicalRank: null, row: d.row });
    });
    ftsRows.forEach((l, i) => {
      const row = lexRows.get(l.id);
      if (!row) return;
      const add = LEX_W * (1 / (K + i + 1));
      const prev = fused.get(l.id);
      if (prev) {
        prev.rrf += add;
        prev.lexical = -l.bm;
        prev.lexicalRank = i + 1;
      } else {
        fused.set(l.id, {
          rrf: add,
          dense: cosineById.get(l.id) ?? 0,
          lexical: -l.bm,
          lexicalRank: i + 1,
          row,
        });
      }
    });

    const ranked = [...fused.values()].sort((a, b) => b.rrf - a.rrf).slice(0, topK);
    return this.toHits(
      ranked.map((r) => ({
        row: r.row,
        score: r.rrf,
        signals: { dense: r.dense, lexical: r.lexical, lexicalRank: r.lexicalRank },
      }))
    );
  }

  /** Recherche lexicale seule — pour les appelants sans provider d'embedding. */
  searchLexical(queryText: string, topK = 10): ReadingNoteSearchHit[] {
    const rows = this.lexicalIds(queryText, topK);
    const byId = this.chunkRows(rows.map((r) => r.id));
    return this.toHits(
      rows.flatMap((r, i) => {
        const row = byId.get(r.id);
        return row ? [{ row, score: -r.bm, signals: { dense: 0, lexical: -r.bm, lexicalRank: i + 1 } }] : [];
      })
    );
  }

  private toHits(
    ranked: Array<{ row: RawChunkRow; score: number; signals: ReadingNoteSearchHit['signals'] }>
  ): ReadingNoteSearchHit[] {
    const noteStmt = this.db.prepare('SELECT * FROM reading_notes WHERE id = ?');
    const hits: ReadingNoteSearchHit[] = [];
    for (const r of ranked) {
      const noteRow = noteStmt.get(r.row.note_id) as RawNoteRow | undefined;
      if (!noteRow) continue;
      hits.push({ chunk: rowToChunk(r.row), note: rowToNote(noteRow), score: r.score, signals: r.signals });
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
  citekey: string;
  zotero_key: string | null;
  title: string | null;
  tags: string;
  content_hash: string;
  indexed_at: string;
}

interface RawChunkRow {
  id: string;
  note_id: string;
  chunk_index: number;
  content: string;
  section_title: string | null;
  line: number;
  embedding: Buffer | null;
}

function parseTags(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function rowToNote(r: RawNoteRow): ReadingNoteRecord {
  return {
    id: r.id,
    relativePath: r.relative_path,
    citekey: r.citekey,
    zoteroKey: r.zotero_key ?? undefined,
    title: r.title ?? undefined,
    tags: parseTags(r.tags),
    contentHash: r.content_hash,
    indexedAt: r.indexed_at,
  };
}

function rowToChunk(r: RawChunkRow): ReadingNoteChunkRecord {
  return {
    id: r.id,
    noteId: r.note_id,
    chunkIndex: r.chunk_index,
    content: r.content,
    sectionTitle: r.section_title ?? undefined,
    line: r.line,
  };
}

/** Identifiant stable d'une note : sa référence, jamais son chemin. */
export function readingNoteId(note: { citekey: string; zoteroKey?: string }): string {
  return note.zoteroKey ? `zotero:${note.zoteroKey}` : `citekey:${note.citekey}`;
}

/** Le corpus des notes de lecture vit dans le `brain.db` partagé du workspace. */
export function readingNotesStorePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.cliodeck', 'brain.db');
}
