/**
 * Tests for the entity_context MCP tool (fusion 1.9).
 *
 * The tool reads `entities` + `entity_mentions` from BOTH databases —
 * primary-sources.db (NER over Tropy) and vectors.db (NER over PDFs,
 * planned). We verify it merges results from both, fails soft on
 * missing tables, and applies the topK budget across the union.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { registerEntityContext } from '../tools/entityContext.js';
import {
  addEntityTables,
  createCapturingServer,
  createInMemoryLogger,
  createTempPrimarySourcesDb,
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

describe('entity_context', () => {
  it('returns the "no NER tables" hint when neither database has them', async () => {
    // Both dbs exist but entities/entity_mentions aren't created. Tool
    // must fail soft.
    const p = createTempPrimarySourcesDb(workspaceRoot);
    p.close();
    const v = createTempVectorsDb(workspaceRoot);
    v.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerEntityContext(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const payload = JSON.parse(
      (await tools.get('entity_context')!.handler({ entity: 'Greiser', topK: 5 }))
        .content[0].text
    );
    expect(payload.mentions).toEqual([]);
    expect(payload.note).toMatch(/run the entity extraction pipeline/i);
  });

  it('returns mentions from primary, joined to source title', async () => {
    const p = createTempPrimarySourcesDb(workspaceRoot);
    addEntityTables(p);
    p.prepare(
      `INSERT INTO entities (id, name, normalized_name, type)
       VALUES ('e1', 'Arthur Greiser', 'arthur greiser', 'PERSON')`
    ).run();
    p.prepare(
      `INSERT INTO primary_sources (id, title) VALUES ('s1', 'Lester diary')`
    ).run();
    p.prepare(
      `INSERT INTO entity_mentions (entity_id, source_id, chunk_id, context)
       VALUES ('e1', 's1', 'ch1', 'Greiser ordered the deportation')`
    ).run();
    p.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerEntityContext(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const payload = JSON.parse(
      (
        await tools
          .get('entity_context')!
          .handler({ entity: 'greiser', topK: 5 })
      ).content[0].text
    );
    expect(payload.mentions).toHaveLength(1);
    const m = payload.mentions[0];
    expect(m.entityName).toBe('Arthur Greiser');
    expect(m.sourceKind).toBe('primary');
    expect(m.sourceTitle).toBe('Lester diary');
    expect(m.context).toContain('Greiser');
  });

  it('merges mentions from primary AND secondary, capped at topK', async () => {
    // Primary: 1 mention. Secondary: 2 mentions. topK = 2 → drop 1.
    const p = createTempPrimarySourcesDb(workspaceRoot);
    addEntityTables(p);
    p.prepare(
      `INSERT INTO entities (id, name, normalized_name, type)
       VALUES ('e1', 'Greiser', 'greiser', 'PERSON')`
    ).run();
    p.prepare(
      `INSERT INTO primary_sources (id, title) VALUES ('s1', 'A')`
    ).run();
    p.prepare(
      `INSERT INTO entity_mentions (entity_id, source_id, context)
       VALUES ('e1', 's1', 'primary ctx')`
    ).run();
    p.close();

    const v = createTempVectorsDb(workspaceRoot);
    addEntityTables(v);
    v.prepare(
      `INSERT INTO entities (id, name, normalized_name, type)
       VALUES ('e2', 'Greiser', 'greiser', 'PERSON')`
    ).run();
    v.prepare(
      `INSERT INTO documents (id, title) VALUES ('d1', 'doc')`
    ).run();
    v.prepare(
      `INSERT INTO entity_mentions (entity_id, source_id, context)
       VALUES ('e2', 'd1', 'sec ctx 1'), ('e2', 'd1', 'sec ctx 2')`
    ).run();
    v.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerEntityContext(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const payload = JSON.parse(
      (
        await tools
          .get('entity_context')!
          .handler({ entity: 'greiser', topK: 2 })
      ).content[0].text
    );
    expect(payload.mentions).toHaveLength(2);
    // Primary comes first per the concat order.
    expect(payload.mentions[0].sourceKind).toBe('primary');
    expect(payload.mentions[1].sourceKind).toBe('secondary');
  });
});
