/**
 * Tests for the Obsidian MCP tool (fusion 1.9).
 *
 * The tool is a thin wrapper over `ObsidianVaultStore.searchLexical`.
 * We seed `obsidian-vectors.db` with a handful of notes/chunks (and the
 * matching FTS5 entries the store relies on) and exercise the handler
 * end-to-end so the SQL contract — including the FTS5 MATCH clause and
 * the chunk truncation — actually executes.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { registerSearchObsidian } from '../tools/searchObsidian.js';
import {
  createCapturingServer,
  createInMemoryLogger,
  createTempObsidianDb,
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

function seedNote(
  db: ReturnType<typeof createTempObsidianDb>,
  opts: {
    noteId: string;
    title: string;
    relativePath: string;
    chunks: Array<{ id: string; content: string; section?: string }>;
  }
): void {
  db.prepare(
    `INSERT INTO notes (id, relative_path, vault_path, title, tags, frontmatter, wikilinks, file_hash, file_mtime, indexed_at)
     VALUES (?, ?, ?, ?, '[]', '{}', '[]', 'hash', 0, '2026-01-01')`
  ).run(opts.noteId, opts.relativePath, '/v/' + opts.relativePath, opts.title);
  let i = 0;
  for (const c of opts.chunks) {
    db.prepare(
      `INSERT INTO chunks (id, note_id, chunk_index, content, section_title, start_position, end_position)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    ).run(c.id, opts.noteId, i, c.content, c.section ?? null, c.content.length);
    db.prepare(`INSERT INTO chunks_fts (id, content) VALUES (?, ?)`).run(
      c.id,
      c.content
    );
    i++;
  }
}

describe('search_obsidian', () => {
  it('returns FTS hits, ranks by BM25, includes path/title/section', async () => {
    const db = createTempObsidianDb(workspaceRoot);
    seedNote(db, {
      noteId: 'n1',
      title: 'Lester journal',
      relativePath: 'lester.md',
      chunks: [
        {
          id: 'c1',
          content: 'Greiser ordered the deportation in 1941.',
          section: 'Wartheland',
        },
      ],
    });
    seedNote(db, {
      noteId: 'n2',
      title: 'Other notes',
      relativePath: 'other.md',
      chunks: [{ id: 'c2', content: 'Unrelated content about Paris.' }],
    });
    db.close();

    const { server, tools } = createCapturingServer();
    const { logger, events } = createInMemoryLogger();
    registerSearchObsidian(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const result = await tools
      .get('search_obsidian')!
      .handler({ query: 'Greiser', topK: 5 });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.query).toBe('Greiser');
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0].notePath).toBe('lester.md');
    expect(payload.hits[0].title).toBe('Lester journal');
    expect(payload.hits[0].section).toBe('Wartheland');
    expect(payload.hits[0].content).toContain('Greiser');
    expect(typeof payload.elapsedMs).toBe('number');
    expect(events[0].output.itemCount).toBe(1);
  });

  it('truncates oversize chunk content with an ellipsis', async () => {
    const db = createTempObsidianDb(workspaceRoot);
    // FTS5 ignores 1-char tokens, so build a long chunk full of a real
    // word and search for it.
    const long = ('Wartheland is a region. ').repeat(100);
    seedNote(db, {
      noteId: 'n1',
      title: 'long',
      relativePath: 'long.md',
      chunks: [{ id: 'c1', content: long }],
    });
    db.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerSearchObsidian(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const result = await tools
      .get('search_obsidian')!
      .handler({ query: 'Wartheland', topK: 5 });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.hits[0].content.endsWith('…')).toBe(true);
    // Truncation budget is 800 chars + ellipsis.
    expect(payload.hits[0].content.length).toBeLessThanOrEqual(801);
  });

  it('returns an empty hit list (not an error) when no FTS rows match', async () => {
    const db = createTempObsidianDb(workspaceRoot);
    seedNote(db, {
      noteId: 'n1',
      title: 't',
      relativePath: 'a.md',
      chunks: [{ id: 'c1', content: 'something else' }],
    });
    db.close();

    const { server, tools } = createCapturingServer();
    const { logger } = createInMemoryLogger();
    registerSearchObsidian(
      server as unknown as McpServer,
      makeMcpConfig(workspaceRoot),
      logger as never
    );
    const result = await tools
      .get('search_obsidian')!
      .handler({ query: 'absolutely-not-present', topK: 5 });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.hits).toEqual([]);
  });
});
