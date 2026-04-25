/**
 * Tests for the Zotero MCP tool (fusion 1.9).
 *
 * Covers: missing-db note, missing-table note, the title/author/bibtex_key
 * LIKE search, the optional year filter, and content truncation.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { registerSearchZotero } from '../tools/searchZotero.js';
import {
  createCapturingServer,
  createInMemoryLogger,
  createTempVectorsDb,
  createTempWorkspace,
  makeMcpConfig,
  rmrf,
} from './_helpers.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

let workspaceRoot: string;
beforeEach(() => {
  workspaceRoot = createTempWorkspace();
});
afterEach(() => {
  rmrf(workspaceRoot);
});

describe('search_zotero', () => {
  it('returns a "no bibliography db" note when neither vectors.db nor bibliography.db exist', async () => {
    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerSearchZotero(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const payload = JSON.parse(
      (await tools.get('search_zotero')!.handler({ query: 'x', topK: 1 }))
        .content[0].text
    );
    expect(payload.hits).toEqual([]);
    expect(payload.note).toMatch(/Index a Zotero library first/i);
  });

  it('returns a clear note when the documents table is missing', async () => {
    const dir = path.join(workspaceRoot, '.cliodeck');
    fs.mkdirSync(dir, { recursive: true });
    // Empty db with no tables. The tool should detect that and bail out
    // gracefully rather than throwing on a malformed prepared statement.
    const db = new Database(path.join(dir, 'vectors.db'));
    db.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerSearchZotero(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const payload = JSON.parse(
      (await tools.get('search_zotero')!.handler({ query: 'x', topK: 1 }))
        .content[0].text
    );
    expect(payload.hits).toEqual([]);
    expect(payload.note).toMatch(/no `documents` table/i);
  });

  it('matches across title / author / bibtex_key, applies the year filter', async () => {
    const db = createTempVectorsDb(workspaceRoot);
    const insert = db.prepare(
      `INSERT INTO documents (id, title, author, year, bibtex_key, file_path, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run('d1', 'Annales 1994', 'Bloch, Marc', '1994', 'bloch1994', null, 'Summary A');
    insert.run('d2', 'Annales 2010', 'Le Goff, Jacques', '2010', 'legoff2010', null, 'Summary B');
    insert.run('d3', 'A bibtex hit', 'Anonymous', '2010', 'bloch1994b', null, null);
    db.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerSearchZotero(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );

    // 'bloch' matches d1 (author) and d3 (bibtex_key) — but year filter
    // narrows to d3 (2010). d1 is dropped.
    const result = await tools
      .get('search_zotero')!
      .handler({ query: 'bloch', year: '2010', topK: 5 });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.hits.map((h: { id: string }) => h.id)).toEqual(['d3']);
  });

  it('truncates oversize summary content with an ellipsis', async () => {
    const db = createTempVectorsDb(workspaceRoot);
    const long = 'L'.repeat(2000);
    db.prepare(
      `INSERT INTO documents (id, title, author, year, bibtex_key, summary)
       VALUES ('d1', 'long summary', 'A', '2020', 'k', ?)`
    ).run(long);
    db.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerSearchZotero(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const payload = JSON.parse(
      (
        await tools
          .get('search_zotero')!
          .handler({ query: 'long', topK: 5 })
      ).content[0].text
    );
    expect(payload.hits[0].summary.endsWith('…')).toBe(true);
    expect(payload.hits[0].summary.length).toBeLessThanOrEqual(801);
  });
});
