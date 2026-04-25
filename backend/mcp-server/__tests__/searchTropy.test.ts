/**
 * Tests for the Tropy MCP tool (fusion 1.9).
 *
 * Exercises the LIKE-search across primary_sources + source_chunks. The
 * tool joins on `source_id`, orders by `date DESC NULLS LAST`, and
 * truncates chunk content to 800 chars. We verify each of those.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { registerSearchTropy } from '../tools/searchTropy.js';
import {
  createCapturingServer,
  createInMemoryLogger,
  createTempPrimarySourcesDb,
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

describe('search_tropy', () => {
  it('returns a clear "no Tropy db" note before any SQL is run', async () => {
    const { server, tools } = createCapturingServer();
    const { logger, events } = createInMemoryLogger();
    registerSearchTropy(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const result = await tools
      .get('search_tropy')!
      .handler({ query: 'anything', topK: 5 });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.hits).toEqual([]);
    expect(payload.note).toMatch(/Link a Tropy project/i);
    expect(events[0].output).toEqual({ itemCount: 0 });
  });

  it('matches by chunk content, source title, AND transcription', async () => {
    const db = createTempPrimarySourcesDb(workspaceRoot);
    db.prepare(
      `INSERT INTO primary_sources (id, title, transcription, date, creator, archive, collection)
       VALUES ('s1', 'Lester diary 1941', 'Greiser referenced here', '1941-09', 'Lester','UN','Danzig')`
    ).run();
    db.prepare(
      `INSERT INTO source_chunks (id, source_id, content, chunk_index)
       VALUES ('c1', 's1', 'Wartheland police report', 0)`
    ).run();
    db.prepare(
      `INSERT INTO primary_sources (id, title, date)
       VALUES ('s2', 'Other source', '2000')`
    ).run();
    db.prepare(
      `INSERT INTO source_chunks (id, source_id, content, chunk_index)
       VALUES ('c2', 's2', 'Unrelated', 0)`
    ).run();
    db.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerSearchTropy(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const result = await tools
      .get('search_tropy')!
      .handler({ query: 'Greiser', topK: 5 });
    const payload = JSON.parse(result.content[0].text);
    // Match comes through transcription (LIKE on ps.transcription).
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0].sourceId).toBe('s1');
    expect(payload.hits[0].title).toBe('Lester diary 1941');
    expect(payload.hits[0].archive).toBe('UN');
  });

  it('orders by date DESC and truncates oversize content', async () => {
    const db = createTempPrimarySourcesDb(workspaceRoot);
    const long = 'spam '.repeat(300);
    db.prepare(
      `INSERT INTO primary_sources (id, title, date) VALUES ('s1', 'old', '1900')`
    ).run();
    db.prepare(
      `INSERT INTO primary_sources (id, title, date) VALUES ('s2', 'new', '2020')`
    ).run();
    db.prepare(
      `INSERT INTO source_chunks (id, source_id, content, chunk_index)
       VALUES ('c1', 's1', ?, 0)`
    ).run(long);
    db.prepare(
      `INSERT INTO source_chunks (id, source_id, content, chunk_index)
       VALUES ('c2', 's2', ?, 0)`
    ).run(long);
    db.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerSearchTropy(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const result = await tools
      .get('search_tropy')!
      .handler({ query: 'spam', topK: 5 });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.hits[0].sourceId).toBe('s2'); // 2020 > 1900
    expect(payload.hits[1].sourceId).toBe('s1');
    expect(payload.hits[0].content.endsWith('…')).toBe(true);
    expect(payload.hits[0].content.length).toBeLessThanOrEqual(801);
  });
});
