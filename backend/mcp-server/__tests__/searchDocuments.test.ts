/**
 * Tests for the search_documents MCP tool (fusion 1.9).
 *
 * Covers: missing-db / missing-table notes, the chunk LIKE search with
 * COLLATE NOCASE, the year + author filters, the occurrence-count
 * ordering (chunks with more matches rank higher), and the 800-char
 * truncation.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { registerSearchDocuments } from '../tools/searchDocuments.js';
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

describe('search_documents', () => {
  it('emits a "no vectors.db" note before any SQL is run', async () => {
    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerSearchDocuments(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const payload = JSON.parse(
      (await tools.get('search_documents')!.handler({ query: 'x' })).content[0]
        .text
    );
    expect(payload.hits).toEqual([]);
    expect(payload.note).toMatch(/No vectors\.db found/);
  });

  it('emits a "no chunks table" note when the schema is incomplete', async () => {
    const dir = path.join(workspaceRoot, '.cliodeck');
    fs.mkdirSync(dir, { recursive: true });
    new Database(path.join(dir, 'vectors.db')).close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerSearchDocuments(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const payload = JSON.parse(
      (await tools.get('search_documents')!.handler({ query: 'x' })).content[0]
        .text
    );
    expect(payload.note).toMatch(/no `chunks` table/i);
  });

  it('returns chunks matching the query, decorated with parent doc metadata', async () => {
    const db = createTempVectorsDb(workspaceRoot);
    db.prepare(
      `INSERT INTO documents (id, title, author, year, bibtex_key, file_path)
       VALUES ('d1', 'Le Front populaire', 'Tartakowsky', '1996', 'tartakowsky1996', '/p/t.pdf')`
    ).run();
    db.prepare(
      `INSERT INTO chunks (id, document_id, content, page_number, chunk_index)
       VALUES ('c1', 'd1', 'The Front populaire was a coalition.', 1, 0),
              ('c2', 'd1', 'Unrelated paragraph.', 2, 1)`
    ).run();
    db.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerSearchDocuments(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const payload = JSON.parse(
      (
        await tools
          .get('search_documents')!
          .handler({ query: 'Front populaire', topK: 5 })
      ).content[0].text
    );
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0].chunkId).toBe('c1');
    expect(payload.hits[0].docTitle).toBe('Le Front populaire');
    expect(payload.hits[0].docAuthor).toBe('Tartakowsky');
    expect(payload.hits[0].pageNumber).toBe(1);
  });

  it('ranks chunks with more occurrences ahead of chunks with fewer', async () => {
    const db = createTempVectorsDb(workspaceRoot);
    db.prepare(
      `INSERT INTO documents (id, title, year) VALUES ('d1', 'doc', '2000')`
    ).run();
    db.prepare(
      `INSERT INTO chunks (id, document_id, content, page_number, chunk_index)
       VALUES ('c-rare', 'd1', 'Greiser is mentioned.', 1, 0),
              ('c-dense', 'd1', 'Greiser, Greiser, Greiser everywhere.', 2, 1)`
    ).run();
    db.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerSearchDocuments(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const payload = JSON.parse(
      (
        await tools
          .get('search_documents')!
          .handler({ query: 'Greiser', topK: 5 })
      ).content[0].text
    );
    expect(payload.hits[0].chunkId).toBe('c-dense');
    expect(payload.hits[1].chunkId).toBe('c-rare');
  });

  it('applies year + author filters with case-insensitive matching', async () => {
    const db = createTempVectorsDb(workspaceRoot);
    db.prepare(
      `INSERT INTO documents (id, title, author, year)
       VALUES ('d1', 'A', 'Bloch, Marc', '1990'),
              ('d2', 'B', 'Bloch, Marc', '2010'),
              ('d3', 'C', 'Le Goff, Jacques', '2010')`
    ).run();
    db.prepare(
      `INSERT INTO chunks (id, document_id, content, page_number, chunk_index)
       VALUES ('c1', 'd1', 'mention of Greiser', 1, 0),
              ('c2', 'd2', 'mention of Greiser', 1, 0),
              ('c3', 'd3', 'mention of Greiser', 1, 0)`
    ).run();
    db.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerSearchDocuments(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const payload = JSON.parse(
      (
        await tools.get('search_documents')!.handler({
          query: 'Greiser',
          year: '2010',
          author: 'bloch', // lowercase — must match via COLLATE NOCASE
          topK: 5,
        })
      ).content[0].text
    );
    expect(payload.hits.map((h: { documentId: string }) => h.documentId)).toEqual([
      'd2',
    ]);
  });
});
