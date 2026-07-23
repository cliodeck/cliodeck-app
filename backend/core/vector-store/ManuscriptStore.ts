/**
 * Store du corpus « manuscrit » (item 25 des audits).
 *
 * Quatrième corpus RAG, à côté des PDF (secondaire), des archives Tropy
 * (primaire) et du vault Obsidian. Il indexe ce que l'historien écrit
 * lui-même : les chapitres d'un livre, ou le document d'un article.
 *
 * Calqué sur `ObsidianVaultStore` — mêmes choix, délibérément : tables
 * préfixées `manuscript_` dans le `.cliodeck/brain.db` partagé, embeddings
 * en BLOB `Float32Array`, recherche hybride cosinus + FTS5 BM25 fusionnée
 * par RRF (K=60, mêmes poids). Deux corpus qui se ressemblent doivent se
 * comporter pareil ; et aucune clé nouvelle dans `workspace/layout.ts`
 * (CLAUDE.md §4) puisque `brain.db` existe déjà.
 *
 * Unité indexée : le **chapitre** (un fichier du manifeste, ou le document
 * unique d'un article). Son empreinte de contenu porte l'incrémental.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface ManuscriptChunkRecord {
  id: string;
  chapterId: string;
  chunkIndex: number;
  content: string;
  sectionTitle?: string;
  /** Ligne 1-indexée du début de section, pour ramener l'auteur au texte. */
  line: number;
}

export interface ManuscriptChapterRecord {
  id: string;
  /** Chemin relatif au projet (`chapters/01.md`, `document.md`). */
  relativePath: string;
  /** Titre du manifeste, ou titre de tête du fichier. */
  title: string;
  /** Rang dans le manuscrit (ordre du manifeste). */
  order: number;
  /** Empreinte du contenu : porte l'incrémental. */
  contentHash: string;
  indexedAt: string;
}

export interface ManuscriptSearchHit {
  chunk: ManuscriptChunkRecord;
  chapter: ManuscriptChapterRecord;
  score: number;
  signals: { dense: number; lexical: number };
}

export interface ManuscriptStoreConfig {
  dbPath: string;
  /**
   * Dimension des embeddings. Facultative : la lecture n'en a pas besoin,
   * et l'indexeur ne la connaît qu'après le premier appel au provider. Elle
   * se verrouille sur le premier `addChunk` et toute insertion ultérieure
   * doit s'y conformer — un index mêlant deux dimensions produirait des
   * cosinus silencieusement faux.
   */
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

export class ManuscriptStore {
  private db: Database.Database;
  private dimension: number | null;

  constructor(cfg: ManuscriptStoreConfig) {
    fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
    this.db = new Database(cfg.dbPath);
    this.dimension = cfg.dimension ?? null;
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS manuscript_chapters (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        chapter_order INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_manuscript_chapters_hash
        ON manuscript_chapters(content_hash);

      CREATE TABLE IF NOT EXISTS manuscript_chunks (
        id TEXT PRIMARY KEY,
        chapter_id TEXT NOT NULL REFERENCES manuscript_chapters(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        section_title TEXT,
        line INTEGER NOT NULL,
        embedding BLOB,
        dimension INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_manuscript_chunks_chapter
        ON manuscript_chunks(chapter_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS manuscript_chunks_fts USING fts5(
        id UNINDEXED,
        content,
        tokenize = 'porter unicode61'
      );
    `);
  }

  // MARK: - writes

  upsertChapter(chapter: ManuscriptChapterRecord): void {
    this.db
      .prepare(
        `INSERT INTO manuscript_chapters (id, relative_path, title, chapter_order, content_hash, indexed_at)
         VALUES (@id, @relative_path, @title, @chapter_order, @content_hash, @indexed_at)
         ON CONFLICT(id) DO UPDATE SET
           relative_path = excluded.relative_path,
           title = excluded.title,
           chapter_order = excluded.chapter_order,
           content_hash = excluded.content_hash,
           indexed_at = excluded.indexed_at`
      )
      .run({
        id: chapter.id,
        relative_path: chapter.relativePath,
        title: chapter.title,
        chapter_order: chapter.order,
        content_hash: chapter.contentHash,
        indexed_at: chapter.indexedAt,
      });
  }

  deleteChapterChunks(chapterId: string): void {
    this.db
      .prepare(
        'DELETE FROM manuscript_chunks_fts WHERE id IN (SELECT id FROM manuscript_chunks WHERE chapter_id = ?)'
      )
      .run(chapterId);
    this.db
      .prepare('DELETE FROM manuscript_chunks WHERE chapter_id = ?')
      .run(chapterId);
  }

  /** Retire un chapitre et ses chunks (fichier supprimé ou détaché). */
  deleteChapter(chapterId: string): void {
    this.deleteChapterChunks(chapterId);
    this.db.prepare('DELETE FROM manuscript_chapters WHERE id = ?').run(chapterId);
  }

  addChunk(chunk: ManuscriptChunkRecord, embedding: Float32Array): void {
    // Première insertion : la dimension du provider fait foi.
    this.dimension ??= embedding.length;
    if (embedding.length !== this.dimension) {
      throw new Error(
        `Embedding dimension mismatch: got ${embedding.length}, expected ${this.dimension}`
      );
    }
    // Un NaN/Infinity passe inaperçu à l'insertion mais empoisonne tout
    // cosinus ultérieur — même garde que le store du vault, où un cas
    // observé corrélait avec un SIGSEGV du binding natif.
    for (let i = 0; i < embedding.length; i++) {
      if (!Number.isFinite(embedding[i])) {
        throw new Error(
          `Embedding for chunk ${chunk.id} contains a non-finite value at index ${i}; refusing to persist.`
        );
      }
    }
    this.db
      .prepare(
        `INSERT INTO manuscript_chunks (id, chapter_id, chunk_index, content, section_title, line, embedding, dimension)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           chunk_index = excluded.chunk_index,
           content = excluded.content,
           section_title = excluded.section_title,
           line = excluded.line,
           embedding = excluded.embedding,
           dimension = excluded.dimension`
      )
      .run(
        chunk.id,
        chunk.chapterId,
        chunk.chunkIndex,
        chunk.content,
        chunk.sectionTitle ?? null,
        chunk.line,
        floatArrayToBuffer(embedding),
        this.dimension
      );
    // FTS5 ne connaît pas l'UPSERT : on efface avant d'insérer.
    this.db.prepare('DELETE FROM manuscript_chunks_fts WHERE id = ?').run(chunk.id);
    this.db
      .prepare('INSERT INTO manuscript_chunks_fts (id, content) VALUES (?, ?)')
      .run(chunk.id, chunk.content);
  }

  // MARK: - reads

  getChapterByPath(relativePath: string): ManuscriptChapterRecord | null {
    const row = this.db
      .prepare('SELECT * FROM manuscript_chapters WHERE relative_path = ?')
      .get(relativePath) as RawChapterRow | undefined;
    return row ? rowToChapter(row) : null;
  }

  listChapters(): ManuscriptChapterRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM manuscript_chapters ORDER BY chapter_order')
      .all() as RawChapterRow[];
    return rows.map(rowToChapter);
  }

  stats(): { chapterCount: number; chunkCount: number } {
    const c1 = this.db
      .prepare('SELECT COUNT(*) AS c FROM manuscript_chapters')
      .get() as { c: number };
    const c2 = this.db
      .prepare('SELECT COUNT(*) AS c FROM manuscript_chunks')
      .get() as { c: number };
    return { chapterCount: c1.c, chunkCount: c2.c };
  }

  // MARK: - search

  /** Recherche hybride : cosinus + BM25, fusion RRF (K=60). */
  search(
    queryEmbedding: Float32Array,
    queryText: string,
    topK = 10
  ): ManuscriptSearchHit[] {
    const K = 60;
    const DENSE_W = 0.6;
    const LEX_W = 0.4;

    const denseRows = this.db
      .prepare(
        `SELECT id, chapter_id, chunk_index, content, section_title, line, embedding
         FROM manuscript_chunks WHERE embedding IS NOT NULL`
      )
      .all() as RawChunkRow[];

    const dense = denseRows
      .map((r) => ({
        id: r.id,
        score: cosine(queryEmbedding, bufferToFloatArray(r.embedding!)),
        row: r,
      }))
      .sort((a, b) => b.score - a.score);

    let lexical: Array<{ id: string; score: number; row: RawChunkRow | null }> = [];
    if (queryText.trim()) {
      try {
        const ftsRows = this.db
          .prepare(
            `SELECT f.id, bm25(manuscript_chunks_fts) AS bm
             FROM manuscript_chunks_fts f
             WHERE manuscript_chunks_fts MATCH ?
             ORDER BY bm
             LIMIT ?`
          )
          .all(escapeFts(queryText), topK * 4) as Array<{ id: string; bm: number }>;

        const byId = new Map<string, RawChunkRow>();
        if (ftsRows.length) {
          const ids = ftsRows.map((r) => r.id);
          const rows = this.db
            .prepare(
              `SELECT id, chapter_id, chunk_index, content, section_title, line, embedding
               FROM manuscript_chunks WHERE id IN (${ids.map(() => '?').join(',')})`
            )
            .all(...ids) as RawChunkRow[];
          for (const r of rows) byId.set(r.id, r);
        }
        lexical = ftsRows.map((r) => ({
          id: r.id,
          score: -r.bm,
          row: byId.get(r.id) ?? null,
        }));
      } catch {
        lexical = [];
      }
    }

    const fused = new Map<
      string,
      { rrf: number; dense: number; lexical: number; row: RawChunkRow }
    >();
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

    const ranked = [...fused.values()]
      .sort((a, b) => b.rrf - a.rrf)
      .slice(0, topK);

    const chapterStmt = this.db.prepare(
      'SELECT * FROM manuscript_chapters WHERE id = ?'
    );
    const hits: ManuscriptSearchHit[] = [];
    for (const r of ranked) {
      const chapterRow = chapterStmt.get(r.row.chapter_id) as
        | RawChapterRow
        | undefined;
      if (!chapterRow) continue;
      hits.push({
        chunk: rowToChunk(r.row),
        chapter: rowToChapter(chapterRow),
        score: r.rrf,
        signals: { dense: r.dense, lexical: r.lexical },
      });
    }
    return hits;
  }

  /** Recherche lexicale seule — pour les appelants sans provider d'embedding. */
  searchLexical(queryText: string, topK = 10): ManuscriptSearchHit[] {
    if (!queryText.trim()) return [];
    let rows: Array<{ id: string; bm: number }>;
    try {
      rows = this.db
        .prepare(
          `SELECT f.id, bm25(manuscript_chunks_fts) AS bm
           FROM manuscript_chunks_fts f
           WHERE manuscript_chunks_fts MATCH ?
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
        `SELECT id, chapter_id, chunk_index, content, section_title, line, embedding
         FROM manuscript_chunks WHERE id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids) as RawChunkRow[];
    const byId = new Map<string, RawChunkRow>();
    for (const r of chunkRows) byId.set(r.id, r);

    const chapterStmt = this.db.prepare(
      'SELECT * FROM manuscript_chapters WHERE id = ?'
    );
    const hits: ManuscriptSearchHit[] = [];
    for (const r of rows) {
      const c = byId.get(r.id);
      if (!c) continue;
      const chapterRow = chapterStmt.get(c.chapter_id) as
        | RawChapterRow
        | undefined;
      if (!chapterRow) continue;
      hits.push({
        chunk: rowToChunk(c),
        chapter: rowToChapter(chapterRow),
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

interface RawChapterRow {
  id: string;
  relative_path: string;
  title: string;
  chapter_order: number;
  content_hash: string;
  indexed_at: string;
}

interface RawChunkRow {
  id: string;
  chapter_id: string;
  chunk_index: number;
  content: string;
  section_title: string | null;
  line: number;
  embedding: Buffer | null;
}

function rowToChapter(r: RawChapterRow): ManuscriptChapterRecord {
  return {
    id: r.id,
    relativePath: r.relative_path,
    title: r.title,
    order: r.chapter_order,
    contentHash: r.content_hash,
    indexedAt: r.indexed_at,
  };
}

function rowToChunk(r: RawChunkRow): ManuscriptChunkRecord {
  return {
    id: r.id,
    chapterId: r.chapter_id,
    chunkIndex: r.chunk_index,
    content: r.content,
    sectionTitle: r.section_title ?? undefined,
    line: r.line,
  };
}

/** Le corpus manuscrit vit dans le `brain.db` partagé du workspace. */
export function manuscriptStorePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.cliodeck', 'brain.db');
}
