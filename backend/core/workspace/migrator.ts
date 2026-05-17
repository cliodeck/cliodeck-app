/**
 * Workspace migrator — produces the flat `.cliodeck/*` layout.
 *
 * Three migration entry points dispatched by `detectWorkspaceVersion`:
 *
 * - `legacy-subdir`: a `.cliodeck/v2/*` directory left over from the pre-flatten
 *   fusion branch. Move every entry up one level. Collisions resolve in favor
 *   of the existing flat file (the live writers — `HNSWVectorStore`, etc. —
 *   only ever wrote to flat; v2 copies were migration debris).
 *
 * - `legacy-flat`: pre-fusion v1. `.cliodeck/` exists with the old SQLite
 *   stores and `hnsw.index`, but no `config.json` anywhere. Migration writes
 *   a default `config.json`; everything else is already at the right path.
 *
 * - `cliobrain`: a bare `.cliobrain/` workspace. Copy canonical artifacts
 *   into the flat layout and merge any `.cliobrain/config.json` into the
 *   new `config.json` (unknown keys preserved).
 *
 * Partial-success report (claw-code lesson 6.3): `copied`, `skipped` with
 * typed reason, `warnings`. Never throws on a single missing file.
 */

import fs from 'fs/promises';
import path from 'path';
import Database from 'better-sqlite3';
import {
  defaultWorkspaceConfig,
  writeWorkspaceConfig,
  type WorkspaceConfig,
} from './config.js';
import {
  detectWorkspaceVersion,
  ensureWorkspaceDirectories,
  workspaceFiles,
  workspacePaths,
  type WorkspaceFiles,
} from './layout.js';

export type SkipReason =
  | 'source_missing'
  | 'target_exists'
  | 'flat_already_present'
  | 'not_a_file'
  | 'empty_source';

export interface MigrationEntry {
  source: string;
  target: string;
}

export interface SkippedEntry extends MigrationEntry {
  reason: SkipReason;
}

export type MigrationKind = 'legacy-subdir' | 'legacy-flat' | 'cliobrain' | 'none';

export interface MigrationReport {
  kind: MigrationKind;
  workspaceRoot: string;
  copied: MigrationEntry[];
  skipped: SkippedEntry[];
  warnings: string[];
  /** Reason the whole migration was a no-op, when applicable. */
  noop?: string;
}

export interface MigrateOptions {
  /** Overwrite existing flat artifacts. Default false — safe by default. */
  overwrite?: boolean;
  /** Override the workspace name written into the new config. */
  name?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function safeStat(p: string): Promise<{ size: number; isFile: boolean } | null> {
  try {
    const s = await fs.stat(p);
    return { size: s.size, isFile: s.isFile() };
  } catch {
    return null;
  }
}

async function copyIfPresent(
  source: string,
  target: string,
  overwrite: boolean,
  report: MigrationReport,
): Promise<void> {
  const stat = await safeStat(source);
  if (!stat) {
    report.skipped.push({ source, target, reason: 'source_missing' });
    return;
  }
  if (!stat.isFile) {
    report.skipped.push({ source, target, reason: 'not_a_file' });
    return;
  }
  if (stat.size === 0) {
    report.skipped.push({ source, target, reason: 'empty_source' });
    return;
  }
  if (!overwrite && (await exists(target))) {
    report.skipped.push({ source, target, reason: 'target_exists' });
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
  report.copied.push({ source, target });
}

function makeReport(kind: MigrationKind, root: string, noop?: string): MigrationReport {
  return { kind, workspaceRoot: root, copied: [], skipped: [], warnings: [], noop };
}

/**
 * Bring the workspace at `root` to flat layout if needed AND consolidate any
 * legacy per-domain SQLite stores (currently `history.db`) into the shared
 * `brain.db`. Idempotent: a fully migrated workspace returns a no-op report.
 *
 * Two phases:
 *   1. Layout — flatten `.cliodeck/v2/*`, absorb `.cliobrain/`, write a default
 *      config for pre-fusion v1 workspaces.
 *   2. Database consolidation — fold `history.db` into `brain.db`. Future
 *      stores (`primary-sources.db`, `vectors.db`, `obsidian-vectors.db`)
 *      will plug in here, one PR at a time.
 */
export async function migrateWorkspaceToFlat(
  workspaceRoot: string,
  opts: MigrateOptions = {},
): Promise<MigrationReport> {
  const version = await detectWorkspaceVersion(workspaceRoot);
  let report: MigrationReport;

  switch (version) {
    case 'none':
      report = makeReport('none', workspaceRoot, 'No workspace artifacts found at root.');
      break;
    case 'flat':
      report = opts.overwrite
        ? await migrateLegacyFlat(workspaceRoot, opts)
        : makeReport('none', workspaceRoot, 'Workspace already at flat layout.');
      break;
    case 'legacy-subdir':
      report = await migrateLegacySubdir(workspaceRoot, opts);
      break;
    case 'legacy-flat':
      report = await migrateLegacyFlat(workspaceRoot, opts);
      break;
    case 'cliobrain':
      report = await migrateCliobrain(workspaceRoot, opts);
      break;
  }

  // Phase 2 runs regardless of the layout outcome — each step is a no-op
  // when its legacy file is absent. Without this, an already-flat workspace
  // would skip consolidation and legacy SQLite files would linger forever.
  await consolidateLegacyHistory(workspaceRoot, report);
  await consolidateLegacyObsidian(workspaceRoot, report);
  await consolidateLegacyPrimarySources(workspaceRoot, report);
  await consolidateLegacyVectors(workspaceRoot, report);
  await renameUnprefixedHistoryTables(workspaceRoot, report);

  // If consolidation produced copies on top of a "no layout work needed"
  // report, drop the misleading noop so callers see something happened.
  if (report.noop && report.copied.length > 0) {
    report.noop = undefined;
  }

  return report;
}

/**
 * Fold `.cliodeck/history.db` into `.cliodeck/brain.db` (db-fusion step 1).
 *
 * Strategy: if `brain.db` is absent (the common case for fresh / pre-fusion
 * workspaces), a single `fs.rename` moves the file atomically — the schema
 * stays valid because HistoryManager's `CREATE TABLE IF NOT EXISTS` calls
 * happily reopen the renamed file. If `brain.db` already exists (ClioBrain
 * import, or repeated runs), warn and skip rather than guess at table-level
 * merge semantics — the user is the only authority on which side wins.
 */
/**
 * Fold `.cliodeck/obsidian-vectors.db` into `.cliodeck/brain.db` (db-fusion
 * step 2). The legacy file uses unprefixed `notes` / `chunks` / `chunks_fts`
 * — we rename them in place to `obsidian_*` (so they don't collide with
 * future PDF/Tropy domains in brain.db), then either rename the whole file
 * to `brain.db` (when no brain.db exists yet) or ATTACH+copy into the
 * existing brain.db.
 *
 * Uses `better-sqlite3` synchronously. Native bindings break under Vitest
 * (`NODE_MODULE_VERSION` mismatch — known issue per CLAUDE.md §6), so the
 * "happy path" is only exercised at runtime under Electron. Tests cover
 * the no-op-if-absent case.
 */
async function consolidateLegacyObsidian(
  root: string,
  report: MigrationReport,
): Promise<void> {
  const legacyObs = path.join(root, '.cliodeck', 'obsidian-vectors.db');
  if (!(await exists(legacyObs))) return;

  const flat = workspaceFiles(root);
  try {
    renameObsidianTablesInPlace(legacyObs);

    if (!(await exists(flat.brainDb))) {
      await fs.rename(legacyObs, flat.brainDb);
      report.copied.push({ source: legacyObs, target: flat.brainDb });
      return;
    }

    // brain.db already exists (typically because history was already folded
    // in). The obsidian_* tables don't collide with history's, so an ATTACH
    // copy is safe.
    copyObsidianIntoBrain(legacyObs, flat.brainDb);
    await fs.unlink(legacyObs);
    report.copied.push({ source: legacyObs, target: flat.brainDb });
  } catch (err) {
    report.warnings.push(
      `Obsidian consolidation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function renameObsidianTablesInPlace(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.exec('BEGIN');
    try {
      // ALTER TABLE RENAME (idempotent: skip if the new name already exists).
      const tableExists = (name: string): boolean =>
        Boolean(
          db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type IN ('table','index') AND name = ?",
            )
            .get(name),
        );

      if (tableExists('notes') && !tableExists('obsidian_notes')) {
        db.exec('ALTER TABLE notes RENAME TO obsidian_notes');
      }
      if (tableExists('chunks') && !tableExists('obsidian_chunks')) {
        db.exec('ALTER TABLE chunks RENAME TO obsidian_chunks');
      }
      // Rename indexes (ALTER INDEX RENAME isn't supported pre-3.25; drop+recreate).
      if (tableExists('idx_notes_hash')) {
        db.exec('DROP INDEX idx_notes_hash');
      }
      if (tableExists('idx_notes_mtime')) {
        db.exec('DROP INDEX idx_notes_mtime');
      }
      if (tableExists('idx_chunks_note')) {
        db.exec('DROP INDEX idx_chunks_note');
      }
      if (tableExists('obsidian_notes')) {
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_obsidian_notes_hash ON obsidian_notes(file_hash)',
        );
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_obsidian_notes_mtime ON obsidian_notes(file_mtime)',
        );
      }
      if (tableExists('obsidian_chunks')) {
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_obsidian_chunks_note ON obsidian_chunks(note_id)',
        );
      }

      // FTS5 virtual table — can't rename, rebuild instead.
      if (tableExists('chunks_fts')) {
        db.exec('DROP TABLE chunks_fts');
      }
      if (tableExists('obsidian_chunks') && !tableExists('obsidian_chunks_fts')) {
        db.exec(
          "CREATE VIRTUAL TABLE obsidian_chunks_fts USING fts5(id UNINDEXED, content, tokenize='porter unicode61')",
        );
        db.exec(
          'INSERT INTO obsidian_chunks_fts (id, content) SELECT id, content FROM obsidian_chunks',
        );
      }

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
}

function copyObsidianIntoBrain(legacyPath: string, brainPath: string): void {
  const db = new Database(brainPath);
  try {
    db.pragma('journal_mode = WAL');
    // ATTACH path is a string literal; escape single quotes.
    const escapedPath = legacyPath.replace(/'/g, "''");
    db.exec(`ATTACH DATABASE '${escapedPath}' AS legacy_obs`);
    try {
      // Create destination tables with the same shape as the renamed legacy.
      db.exec(`
        CREATE TABLE IF NOT EXISTS obsidian_notes (
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
        CREATE INDEX IF NOT EXISTS idx_obsidian_notes_hash ON obsidian_notes(file_hash);
        CREATE INDEX IF NOT EXISTS idx_obsidian_notes_mtime ON obsidian_notes(file_mtime);

        CREATE TABLE IF NOT EXISTS obsidian_chunks (
          id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL REFERENCES obsidian_notes(id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL,
          content TEXT NOT NULL,
          section_title TEXT,
          start_position INTEGER NOT NULL,
          end_position INTEGER NOT NULL,
          embedding BLOB,
          dimension INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_obsidian_chunks_note ON obsidian_chunks(note_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS obsidian_chunks_fts USING fts5(
          id UNINDEXED, content, tokenize='porter unicode61'
        );
      `);
      db.exec(
        'INSERT OR IGNORE INTO obsidian_notes SELECT * FROM legacy_obs.obsidian_notes',
      );
      db.exec(
        'INSERT OR IGNORE INTO obsidian_chunks SELECT * FROM legacy_obs.obsidian_chunks',
      );
      // FTS5 rebuild from copied chunks rather than copying the FTS rows
      // (faster, and the rank/segment metadata is regenerated cleanly).
      db.exec('DELETE FROM obsidian_chunks_fts');
      db.exec(
        'INSERT INTO obsidian_chunks_fts (id, content) SELECT id, content FROM obsidian_chunks',
      );
    } finally {
      db.exec('DETACH DATABASE legacy_obs');
    }
  } finally {
    db.close();
  }
}

/**
 * Fold `.cliodeck/primary-sources.db` into `.cliodeck/brain.db` (db-fusion
 * step 3). The legacy file uses the unprefixed `primary_sources`,
 * `source_chunks`, `source_photos`, `source_tags`, `tropy_projects`,
 * `entities`, `entity_mentions`, `entity_relations` tables — rename them in
 * place to the `tropy_*` namespace, then either rename the whole file to
 * `brain.db` (when none exists) or ATTACH+copy into the existing one.
 *
 * Same Vitest caveat as the Obsidian step: the SQL path can't be exercised
 * under the test harness (CLAUDE.md §6); runtime validation only.
 */
async function consolidateLegacyPrimarySources(
  root: string,
  report: MigrationReport,
): Promise<void> {
  const legacy = path.join(root, '.cliodeck', 'primary-sources.db');
  if (!(await exists(legacy))) return;

  const flat = workspaceFiles(root);
  try {
    renamePrimarySourcesTablesInPlace(legacy);

    if (!(await exists(flat.brainDb))) {
      await fs.rename(legacy, flat.brainDb);
      report.copied.push({ source: legacy, target: flat.brainDb });
      return;
    }

    copyPrimarySourcesIntoBrain(legacy, flat.brainDb);
    await fs.unlink(legacy);
    report.copied.push({ source: legacy, target: flat.brainDb });
  } catch (err) {
    report.warnings.push(
      `Primary-sources consolidation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const PRIMARY_TABLE_RENAMES: Array<[string, string]> = [
  ['primary_sources', 'tropy_sources'],
  ['source_chunks', 'tropy_chunks'],
  ['source_photos', 'tropy_photos'],
  ['source_tags', 'tropy_tags'],
  ['entities', 'tropy_entities'],
  ['entity_mentions', 'tropy_entity_mentions'],
  ['entity_relations', 'tropy_entity_relations'],
  // `tropy_projects` was already prefixed.
];

const PRIMARY_INDEX_DROPS = [
  'idx_source_chunks_source',
  'idx_source_tags_tag',
  'idx_source_photos_source',
  'idx_primary_sources_tropy_id',
  'idx_primary_sources_archive',
  'idx_primary_sources_collection',
  'idx_entities_normalized',
  'idx_entities_type',
  'idx_entities_name',
  'idx_entity_mentions_entity',
  'idx_entity_mentions_chunk',
  'idx_entity_mentions_source',
];

function renamePrimarySourcesTablesInPlace(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.exec('BEGIN');
    try {
      const objectExists = (name: string): boolean =>
        Boolean(
          db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type IN ('table','index') AND name = ?",
            )
            .get(name),
        );

      for (const [oldName, newName] of PRIMARY_TABLE_RENAMES) {
        if (objectExists(oldName) && !objectExists(newName)) {
          db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
        }
      }
      // Drop legacy indexes; the runtime side will recreate prefixed ones
      // on next open via `createIndexes`.
      for (const idx of PRIMARY_INDEX_DROPS) {
        if (objectExists(idx)) {
          db.exec(`DROP INDEX ${idx}`);
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
}

function copyPrimarySourcesIntoBrain(legacyPath: string, brainPath: string): void {
  const db = new Database(brainPath);
  try {
    db.pragma('journal_mode = WAL');
    const escapedPath = legacyPath.replace(/'/g, "''");
    db.exec(`ATTACH DATABASE '${escapedPath}' AS legacy_ps`);
    try {
      // For each renamed table, create-if-missing in main and copy rows. The
      // schema string is whatever the legacy db carried (we copy it verbatim
      // from sqlite_master), which keeps any historical column drift intact.
      for (const [, newName] of PRIMARY_TABLE_RENAMES) {
        const createSql = db
          .prepare(
            `SELECT sql FROM legacy_ps.sqlite_master WHERE type='table' AND name=?`,
          )
          .get(newName) as { sql: string } | undefined;
        if (!createSql?.sql) continue;
        db.exec(createSql.sql);
        db.exec(
          `INSERT OR IGNORE INTO ${newName} SELECT * FROM legacy_ps.${newName}`,
        );
      }
      // `tropy_projects` was already prefixed pre-rename, so it isn't in
      // the table-renames list. Copy it separately.
      const tropyProjectsSql = db
        .prepare(
          `SELECT sql FROM legacy_ps.sqlite_master WHERE type='table' AND name='tropy_projects'`,
        )
        .get() as { sql: string } | undefined;
      if (tropyProjectsSql?.sql) {
        db.exec(tropyProjectsSql.sql);
        db.exec(
          'INSERT OR IGNORE INTO tropy_projects SELECT * FROM legacy_ps.tropy_projects',
        );
      }
    } finally {
      db.exec('DETACH DATABASE legacy_ps');
    }
  } finally {
    db.close();
  }
}

/**
 * Fold `.cliodeck/vectors.db` into `.cliodeck/brain.db` (db-fusion step 4).
 * Renames every legacy table to the `pdf_*` namespace, then merges.
 */
async function consolidateLegacyVectors(
  root: string,
  report: MigrationReport,
): Promise<void> {
  const legacy = path.join(root, '.cliodeck', 'vectors.db');
  if (!(await exists(legacy))) return;

  const flat = workspaceFiles(root);
  try {
    renameVectorsTablesInPlace(legacy);

    if (!(await exists(flat.brainDb))) {
      await fs.rename(legacy, flat.brainDb);
      report.copied.push({ source: legacy, target: flat.brainDb });
      return;
    }

    copyVectorsIntoBrain(legacy, flat.brainDb);
    await fs.unlink(legacy);
    report.copied.push({ source: legacy, target: flat.brainDb });
  } catch (err) {
    report.warnings.push(
      `Vectors consolidation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const VECTORS_TABLE_RENAMES: Array<[string, string]> = [
  ['documents', 'pdf_documents'],
  ['chunks', 'pdf_chunks'],
  ['document_citations', 'pdf_citations'],
  ['document_similarities', 'pdf_similarities'],
  ['topic_analyses', 'pdf_topic_analyses'],
  ['topics', 'pdf_topics'],
  ['topic_assignments', 'pdf_topic_assignments'],
  ['topic_outliers', 'pdf_topic_outliers'],
  ['zotero_collections', 'pdf_zotero_collections'],
  ['document_collections', 'pdf_document_collections'],
];

const VECTORS_INDEX_DROPS = [
  'idx_chunks_document_id',
  'idx_chunks_page_number',
  'idx_chunks_content_hash',
  'idx_citations_source',
  'idx_citations_target',
  'idx_similarities_doc1',
  'idx_similarities_doc2',
  'idx_topics_analysis',
  'idx_topic_assignments_analysis',
  'idx_topic_assignments_document',
  'idx_topic_outliers_analysis',
  'idx_doc_collections_coll',
];

function renameVectorsTablesInPlace(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.exec('BEGIN');
    try {
      const objectExists = (name: string): boolean =>
        Boolean(
          db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type IN ('table','index') AND name = ?",
            )
            .get(name),
        );

      for (const [oldName, newName] of VECTORS_TABLE_RENAMES) {
        if (objectExists(oldName) && !objectExists(newName)) {
          db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
        }
      }
      for (const idx of VECTORS_INDEX_DROPS) {
        if (objectExists(idx)) {
          db.exec(`DROP INDEX ${idx}`);
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
}

function copyVectorsIntoBrain(legacyPath: string, brainPath: string): void {
  const db = new Database(brainPath);
  try {
    db.pragma('journal_mode = WAL');
    const escapedPath = legacyPath.replace(/'/g, "''");
    db.exec(`ATTACH DATABASE '${escapedPath}' AS legacy_pdf`);
    try {
      for (const [, newName] of VECTORS_TABLE_RENAMES) {
        const createSql = db
          .prepare(
            `SELECT sql FROM legacy_pdf.sqlite_master WHERE type='table' AND name=?`,
          )
          .get(newName) as { sql: string } | undefined;
        if (!createSql?.sql) continue;
        db.exec(createSql.sql);
        db.exec(
          `INSERT OR IGNORE INTO ${newName} SELECT * FROM legacy_pdf.${newName}`,
        );
      }
    } finally {
      db.exec('DETACH DATABASE legacy_pdf');
    }
  } finally {
    db.close();
  }
}

/**
 * Prefix history tables with `history_` inside brain.db, in place
 * (db-fusion step 5). The first history consolidation (step 1) just did
 * `fs.rename history.db → brain.db`, which preserved the original
 * unprefixed names (`sessions`, `events`, `chat_messages`,
 * `ai_operations`, `document_operations`, `pdf_operations` plus their
 * indexes). Now that obsidian/tropy/pdf are all prefixed, give history
 * the same treatment for consistency and to avoid future collisions
 * (e.g. a `chat_messages` table arriving from another domain).
 *
 * Runs every project load; the table-existence checks make it a no-op
 * once the rename has happened.
 */
const HISTORY_TABLE_RENAMES: Array<[string, string]> = [
  ['sessions', 'history_sessions'],
  ['events', 'history_events'],
  ['chat_messages', 'history_chat_messages'],
  ['ai_operations', 'history_ai_operations'],
  ['document_operations', 'history_document_operations'],
  ['pdf_operations', 'history_pdf_operations'],
];

const HISTORY_INDEX_RENAMES: Array<[string, string]> = [
  ['idx_events_session', 'idx_history_events_session'],
  ['idx_events_type', 'idx_history_events_type'],
  ['idx_events_timestamp', 'idx_history_events_timestamp'],
  ['idx_chat_session', 'idx_history_chat_session'],
  ['idx_chat_timestamp', 'idx_history_chat_timestamp'],
  ['idx_chat_mode', 'idx_history_chat_mode'],
  ['idx_ai_ops_session', 'idx_history_ai_ops_session'],
  ['idx_ai_ops_type', 'idx_history_ai_ops_type'],
  ['idx_ai_ops_timestamp', 'idx_history_ai_ops_timestamp'],
  ['idx_doc_ops_session', 'idx_history_doc_ops_session'],
  ['idx_doc_ops_timestamp', 'idx_history_doc_ops_timestamp'],
  ['idx_pdf_ops_session', 'idx_history_pdf_ops_session'],
  ['idx_pdf_ops_timestamp', 'idx_history_pdf_ops_timestamp'],
];

async function renameUnprefixedHistoryTables(
  root: string,
  report: MigrationReport,
): Promise<void> {
  const flat = workspaceFiles(root);
  if (!(await exists(flat.brainDb))) return;

  let db: Database.Database;
  try {
    db = new Database(flat.brainDb);
  } catch {
    // brain.db isn't a real SQLite file yet (test fixture, partial migration,
    // native binding mismatch under Vitest, etc.). The next runtime open
    // through HistoryManager will produce a proper SQLite db with the new
    // names, so we silently skip rather than warn.
    return;
  }

  try {
    const objectExists = (name: string): boolean =>
      Boolean(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table','index') AND name = ?",
          )
          .get(name),
      );

    // Nothing to do if no unprefixed history table is left.
    const anyLegacy = HISTORY_TABLE_RENAMES.some(([oldName]) => objectExists(oldName));
    if (!anyLegacy) return;

    db.pragma('journal_mode = WAL');
    db.exec('BEGIN');
    try {
      for (const [oldName, newName] of HISTORY_TABLE_RENAMES) {
        if (objectExists(oldName) && !objectExists(newName)) {
          db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
        }
      }
      // SQLite preserves indexes during ALTER TABLE RENAME, but their names
      // still reference the old table convention. Rename them explicitly
      // (SQLite ≥ 3.25 supports `ALTER INDEX RENAME`; for older builds the
      // drop+recreate path runs from `createIndexes` on next open).
      for (const [oldIdx, newIdx] of HISTORY_INDEX_RENAMES) {
        if (objectExists(oldIdx) && !objectExists(newIdx)) {
          try {
            db.exec(`ALTER INDEX ${oldIdx} RENAME TO ${newIdx}`);
          } catch {
            // Fallback: drop the old index; createIndexes will recreate.
            db.exec(`DROP INDEX ${oldIdx}`);
          }
        }
      }
      db.exec('COMMIT');
      report.copied.push({
        source: `${flat.brainDb}#history_*`,
        target: `${flat.brainDb}#history_*`,
      });
    } catch (e) {
      db.exec('ROLLBACK');
      report.warnings.push(
        `History table rename failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } finally {
    db.close();
  }
}

async function consolidateLegacyHistory(
  root: string,
  report: MigrationReport,
): Promise<void> {
  const legacyHistory = path.join(root, '.cliodeck', 'history.db');
  if (!(await exists(legacyHistory))) return;

  const flat = workspaceFiles(root);
  if (await exists(flat.brainDb)) {
    report.warnings.push(
      `Cannot consolidate ${legacyHistory} into ${flat.brainDb}: both files exist. ` +
        `Resolve by hand (back up one, delete the other) before retrying.`,
    );
    return;
  }

  try {
    await fs.rename(legacyHistory, flat.brainDb);
    report.copied.push({ source: legacyHistory, target: flat.brainDb });
  } catch (err) {
    // EXDEV fallback — unlikely on a single-volume workspace, but cheap to guard.
    try {
      await fs.copyFile(legacyHistory, flat.brainDb);
      await fs.unlink(legacyHistory);
      report.copied.push({ source: legacyHistory, target: flat.brainDb });
      report.warnings.push(
        `history.db rename fell back to copy: ${err instanceof Error ? err.message : String(err)}`,
      );
    } catch (e2) {
      report.warnings.push(
        `Failed to consolidate history.db into brain.db: ${e2 instanceof Error ? e2.message : String(e2)}`,
      );
    }
  }
}

/**
 * Move every entry in `.cliodeck/v2/` up to `.cliodeck/`. Per-file rename for
 * atomicity; fall back to copy+unlink on EXDEV. On name collisions the flat
 * file wins (`flat_already_present` skip reason) unless `overwrite` is set.
 */
async function migrateLegacySubdir(
  root: string,
  opts: MigrateOptions,
): Promise<MigrationReport> {
  const report = makeReport('legacy-subdir', root);
  const paths = workspacePaths(root);
  const flat = await ensureWorkspaceDirectories(root);

  const entries = await fs.readdir(paths.legacyV2Dir, { withFileTypes: true });
  for (const e of entries) {
    const source = path.join(paths.legacyV2Dir, e.name);
    const target = path.join(flat.root, e.name);
    if (e.isDirectory()) {
      await mergeDir(source, target, opts.overwrite ?? false, report);
      await fs.rmdir(source).catch(() => {
        /* dir may be non-empty after collisions — leave it for the caller to see */
      });
    } else {
      await moveFile(source, target, opts.overwrite ?? false, report);
    }
  }

  try {
    await fs.rmdir(paths.legacyV2Dir);
  } catch (e) {
    report.warnings.push(
      `legacy .cliodeck/v2/ not removed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!(await exists(flat.config))) {
    // The v2 subdir lacked a config.json — write a default so the workspace is openable.
    await writeWorkspaceConfig(root, defaultWorkspaceConfig(opts.name ?? path.basename(root)));
    report.copied.push({ source: '(generated)', target: flat.config });
  }

  return report;
}

async function moveFile(
  source: string,
  target: string,
  overwrite: boolean,
  report: MigrationReport,
): Promise<void> {
  if (!overwrite && (await exists(target))) {
    report.skipped.push({ source, target, reason: 'flat_already_present' });
    return;
  }
  try {
    await fs.rename(source, target);
    report.copied.push({ source, target });
  } catch (err) {
    // EXDEV (cross-device) or similar — fall back to copy+unlink.
    await fs.copyFile(source, target);
    await fs.unlink(source);
    report.copied.push({ source, target });
    report.warnings.push(
      `rename fell back to copy for ${source}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function mergeDir(
  source: string,
  target: string,
  overwrite: boolean,
  report: MigrationReport,
): Promise<void> {
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(source, e.name);
    const t = path.join(target, e.name);
    if (e.isDirectory()) {
      await mergeDir(s, t, overwrite, report);
      await fs.rmdir(s).catch(() => {});
    } else {
      await moveFile(s, t, overwrite, report);
    }
  }
}

/** Pre-fusion v1 workspace: ensure a flat `config.json` exists. */
async function migrateLegacyFlat(
  root: string,
  opts: MigrateOptions,
): Promise<MigrationReport> {
  const report = makeReport('legacy-flat', root);
  const flat = await ensureWorkspaceDirectories(root);

  if (!(await exists(flat.config)) || opts.overwrite) {
    await writeWorkspaceConfig(
      root,
      defaultWorkspaceConfig(opts.name ?? path.basename(root)),
    );
    report.copied.push({ source: '(generated)', target: flat.config });
  } else {
    report.skipped.push({
      source: '(generated)',
      target: flat.config,
      reason: 'target_exists',
    });
  }

  return report;
}

/**
 * File-match list for ClioBrain → flat. Extend when a real ClioBrain workspace
 * is observed; the paths below are the plausible canonical ones per the fusion
 * strategy doc.
 */
const CLIOBRAIN_MATCHES: Array<{ source: string; target: keyof WorkspaceFiles }> = [
  { source: 'brain.db', target: 'brainDb' },
  { source: 'hnsw.index', target: 'hnswIndex' },
  { source: 'hints.md', target: 'hints' },
  { source: 'mcp-access.jsonl', target: 'mcpAccessLog' },
];

async function migrateCliobrain(
  root: string,
  opts: MigrateOptions,
): Promise<MigrationReport> {
  const report = makeReport('cliobrain', root);
  const paths = workspacePaths(root);
  const flat = await ensureWorkspaceDirectories(root);

  for (const m of CLIOBRAIN_MATCHES) {
    const source = path.join(paths.cliobrainDir, m.source);
    const target = flat[m.target] as string;
    await copyIfPresent(source, target, opts.overwrite ?? false, report);
  }

  // Merge ClioBrain config.json into the flat config (preserving unknown keys).
  const cliobrainCfg = path.join(paths.cliobrainDir, 'config.json');
  if (await exists(cliobrainCfg)) {
    try {
      const raw = await fs.readFile(cliobrainCfg, 'utf8');
      const legacy = JSON.parse(raw) as Record<string, unknown>;
      const merged: WorkspaceConfig = {
        ...defaultWorkspaceConfig(opts.name ?? path.basename(root)),
        ...legacy,
        schema_version: 2,
      };
      if (!(await exists(flat.config)) || opts.overwrite) {
        await writeWorkspaceConfig(root, merged);
        report.copied.push({ source: cliobrainCfg, target: flat.config });
      } else {
        report.skipped.push({
          source: cliobrainCfg,
          target: flat.config,
          reason: 'target_exists',
        });
      }
    } catch (e) {
      report.warnings.push(
        `Failed to parse ClioBrain config.json: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else if (!(await exists(flat.config))) {
    await writeWorkspaceConfig(
      root,
      defaultWorkspaceConfig(opts.name ?? path.basename(root)),
    );
    report.copied.push({ source: '(generated)', target: flat.config });
  }

  if (report.copied.length === 0) {
    report.warnings.push(
      'ClioBrain → flat migration ran but copied nothing; .cliobrain looks empty or uses an unrecognized layout.',
    );
  }
  return report;
}
