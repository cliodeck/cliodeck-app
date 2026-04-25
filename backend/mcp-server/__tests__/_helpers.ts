/**
 * Shared test fixtures for MCP tool tests (fusion 1.9).
 *
 * The tools register against a real `McpServer` from `@modelcontextprotocol/sdk`
 * and execute SQL on the workspace's sqlite databases. Spinning up the SDK
 * just to invoke a tool handler is overkill — the only thing each test
 * needs is the handler itself, the `cfg` it reads from, and a logger.
 *
 * `createCapturingServer()` records the `(name, schema, handler)` triple
 * that `registerXxx(server, …)` produces so a test can pull the handler
 * out and call it directly. `createInMemoryLogger()` mirrors the
 * `MCPAccessLogger` surface but stores events in an array for assertion.
 *
 * SQLite fixtures (`createTempVectorsDb`, `createTempPrimarySourcesDb`)
 * build minimal schemas — only the columns the tools read — so a test
 * can populate them without dragging in `PrimarySourcesVectorStore` or
 * `ObsidianVaultStore`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type { MCPRuntimeConfig } from '../config.js';
import { v2Paths } from '../../core/workspace/layout.js';

export interface CapturedTool {
  name: string;
  description: string;
  schema: unknown;
  handler: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

export function createCapturingServer(): {
  server: { tool: (...args: unknown[]) => void };
  tools: Map<string, CapturedTool>;
} {
  const tools = new Map<string, CapturedTool>();
  return {
    tools,
    server: {
      tool: (...args: unknown[]) => {
        // The McpServer.tool overload we care about is
        // (name, description, schema, handler). Other overloads exist
        // but the cliodeck tools only use this one.
        const [name, description, schema, handler] = args as [
          string,
          string,
          unknown,
          CapturedTool['handler'],
        ];
        tools.set(name, { name, description, schema, handler });
      },
    },
  };
}

export interface CapturedLogEvent {
  kind: string;
  name: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  at: string;
}

export function createInMemoryLogger(): {
  logger: { log: (e: CapturedLogEvent) => void };
  events: CapturedLogEvent[];
} {
  const events: CapturedLogEvent[] = [];
  return {
    events,
    logger: {
      log: (e: CapturedLogEvent) => {
        events.push(e);
      },
    },
  };
}

/** Make an isolated workspace dir under the OS temp tree. */
export function createTempWorkspace(prefix = 'cliodeck-mcp-tools-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // The MCP tools never check that .cliodeck/v2 exists; they only build
  // paths off it. Create it so callers that drop a v2 config there work.
  fs.mkdirSync(path.join(root, '.cliodeck', 'v2'), { recursive: true });
  return root;
}

/**
 * Build a minimal `MCPRuntimeConfig` pointing at a temp workspace. Only
 * the fields a tool reads are filled in — `mcp` settings are irrelevant
 * to the tool handlers themselves.
 */
export function makeMcpConfig(workspaceRoot: string): MCPRuntimeConfig {
  return {
    workspaceRoot,
    paths: v2Paths(workspaceRoot),
    workspace: {
      schema_version: 2,
    },
    mcp: { enabled: true },
  };
}

/**
 * Create `<root>/.cliodeck/vectors.db` with the columns
 * `searchDocuments`, `searchZotero`, `graphNeighbors`, `entityContext`
 * read. Returns the open `Database` so the caller can populate it; close
 * it before the tool runs (the tool opens its own readonly handle).
 */
export function createTempVectorsDb(root: string): Database.Database {
  const dir = path.join(root, '.cliodeck');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'vectors.db'));
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      title TEXT,
      author TEXT,
      year TEXT,
      bibtex_key TEXT,
      file_path TEXT,
      summary TEXT
    );
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      content TEXT NOT NULL,
      page_number INTEGER,
      chunk_index INTEGER
    );
    CREATE TABLE document_citations (
      source_doc_id TEXT NOT NULL,
      target_doc_id TEXT,
      target_citation TEXT,
      context TEXT,
      page_number INTEGER
    );
  `);
  return db;
}

/**
 * Add the `entities` + `entity_mentions` tables to an existing db. Used
 * by `entityContext` tests; the schema is the same on both vectors.db
 * and primary-sources.db so this helper covers both.
 */
export function addEntityTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      type TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entity_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      chunk_id TEXT,
      context TEXT
    );
  `);
}

/** Create `document_similarities` on an existing vectors db. */
export function addSimilaritiesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_similarities (
      doc_id_1 TEXT NOT NULL,
      doc_id_2 TEXT NOT NULL,
      similarity REAL NOT NULL
    );
  `);
}

/**
 * Create `<root>/.cliodeck/primary-sources.db` with the columns the
 * `searchTropy` tool reads.
 */
export function createTempPrimarySourcesDb(root: string): Database.Database {
  const dir = path.join(root, '.cliodeck');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'primary-sources.db'));
  db.exec(`
    CREATE TABLE primary_sources (
      id TEXT PRIMARY KEY,
      title TEXT,
      transcription TEXT,
      date TEXT,
      creator TEXT,
      archive TEXT,
      collection TEXT
    );
    CREATE TABLE source_chunks (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      content TEXT NOT NULL,
      chunk_index INTEGER
    );
  `);
  return db;
}

/**
 * Create `<root>/.cliodeck/v2/obsidian-vectors.db` with the schema that
 * `ObsidianVaultStore.searchLexical` requires (notes + chunks + chunks_fts).
 */
export function createTempObsidianDb(root: string): Database.Database {
  const dir = path.join(root, '.cliodeck', 'v2');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'obsidian-vectors.db'));
  db.exec(`
    CREATE TABLE notes (
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
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      section_title TEXT,
      start_position INTEGER NOT NULL,
      end_position INTEGER NOT NULL,
      embedding BLOB,
      dimension INTEGER
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      id UNINDEXED,
      content,
      tokenize = 'porter unicode61'
    );
  `);
  return db;
}

export function rmrf(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
