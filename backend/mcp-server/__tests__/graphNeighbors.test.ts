/**
 * Tests for the graph_neighbors MCP tool (fusion 1.9).
 *
 * Three result slices are exercised:
 *   - outbound: this doc cites X (LEFT JOIN on documents to allow
 *     dangling cite targets).
 *   - inbound:  Y cites this doc (INNER JOIN — we only surface known
 *     citing docs).
 *   - similar:  pre-computed cosine neighbors from
 *     `document_similarities` (only when that table exists).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { registerGraphNeighbors } from '../tools/graphNeighbors.js';
import {
  addSimilaritiesTable,
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

describe('graph_neighbors', () => {
  it('emits a "no vectors.db" note before any SQL is run', async () => {
    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerGraphNeighbors(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const payload = JSON.parse(
      (await tools.get('graph_neighbors')!.handler({ documentId: 'd1' }))
        .content[0].text
    );
    expect(payload.neighbors).toEqual([]);
    expect(payload.note).toMatch(/Index the corpus first/i);
  });

  it('returns outbound + inbound citations decorated with target/source title', async () => {
    const db = createTempVectorsDb(workspaceRoot);
    db.prepare(
      `INSERT INTO documents (id, title, year)
       VALUES ('A', 'Source A', '2000'),
              ('B', 'Target B', '1990'),
              ('C', 'Citer C', '2010')`
    ).run();
    db.prepare(
      `INSERT INTO document_citations (source_doc_id, target_doc_id, target_citation, context, page_number)
       VALUES ('A', 'B', 'Smith 1990', 'cf. Smith…', 12),
              ('C', 'A', null,         'as A argues', 5)`
    ).run();
    db.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerGraphNeighbors(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const payload = JSON.parse(
      (
        await tools
          .get('graph_neighbors')!
          .handler({ documentId: 'A', topK: 5 })
      ).content[0].text
    );
    expect(payload.self?.id).toBe('A');
    expect(payload.outbound).toHaveLength(1);
    expect(payload.outbound[0]).toMatchObject({ id: 'B', title: 'Target B' });
    expect(payload.inbound).toHaveLength(1);
    expect(payload.inbound[0]).toMatchObject({ id: 'C', title: 'Citer C' });
  });

  it('returns similar docs ranked by similarity DESC when the table exists', async () => {
    const db = createTempVectorsDb(workspaceRoot);
    addSimilaritiesTable(db);
    db.prepare(
      `INSERT INTO documents (id, title, year)
       VALUES ('A', 'src', '2000'),
              ('B', 'b', '1990'),
              ('C', 'c', '2010')`
    ).run();
    db.prepare(
      `INSERT INTO document_similarities (doc_id_1, doc_id_2, similarity)
       VALUES ('A', 'B', 0.42),
              ('C', 'A', 0.91)`
    ).run();
    db.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerGraphNeighbors(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const payload = JSON.parse(
      (
        await tools
          .get('graph_neighbors')!
          .handler({ documentId: 'A', topK: 5 })
      ).content[0].text
    );
    expect(payload.similar).toHaveLength(2);
    // The query unwraps the doc_id_2 / doc_id_1 disjunction so the
    // returned `id` is always the non-self one.
    const ids = payload.similar.map((s: { id: string }) => s.id);
    expect(ids[0]).toBe('C'); // 0.91 ranks above 0.42
    expect(ids[1]).toBe('B');
    // Decorated with title.
    expect(payload.similar[0].title).toBe('c');
  });

  it('returns an empty `similar` slice (not undefined) when the table is missing', async () => {
    const db = createTempVectorsDb(workspaceRoot);
    db.prepare(
      `INSERT INTO documents (id, title, year) VALUES ('A', 'x', '2000')`
    ).run();
    db.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerGraphNeighbors(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const payload = JSON.parse(
      (
        await tools
          .get('graph_neighbors')!
          .handler({ documentId: 'A', topK: 5 })
      ).content[0].text
    );
    expect(payload.similar).toEqual([]);
  });
});
