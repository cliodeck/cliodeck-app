/**
 * search_tropy — MCP tool exposing the workspace's Tropy primary sources
 * (fusion step 2.6).
 *
 * Reads `<workspaceRoot>/.cliodeck/primary-sources.db` in read-only mode.
 * The schema ships by `PrimarySourcesVectorStore`: `primary_sources`,
 * `source_chunks`, `source_tags`. There is no FTS5 virtual table in that
 * schema today, so we fall back to case-insensitive LIKE across
 * chunk content / source title / transcription. When the indexer gains
 * an FTS5 shadow table we can swap the match clause without changing
 * the tool surface.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { MCPAccessLogger } from '../logger.js';
import type { MCPRuntimeConfig } from '../config.js';

const TOOL_NAME = 'search_tropy';
const TRUNCATE = 800;

function truncate(s: string | null | undefined): string {
  if (!s) return '';
  return s.length > TRUNCATE ? s.slice(0, TRUNCATE) + '…' : s;
}

export function registerSearchTropy(
  server: McpServer,
  cfg: MCPRuntimeConfig,
  logger: MCPAccessLogger
): void {
  server.tool(
    TOOL_NAME,
    'Lexical search across the workspace Tropy primary sources (title, transcription, chunks). Returns matching chunks with their source metadata.',
    {
      query: z.string().min(1).describe('Search query (case-insensitive LIKE).'),
      topK: z.number().int().min(1).max(50).optional().default(10),
    },
    async ({ query, topK }) => {
      const start = Date.now();
      const k = topK ?? 10;
      const dbPath = path.join(
        cfg.workspaceRoot,
        '.cliodeck',
        'primary-sources.db'
      );
      let db: Database.Database | null = null;
      try {
        if (!fs.existsSync(dbPath)) {
          logger.log({
            kind: 'tool_call',
            at: new Date().toISOString(),
            name: TOOL_NAME,
            input: { query, topK: k },
            output: { itemCount: 0 },
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    query,
                    hits: [],
                    note: 'No primary-sources.db found. Link a Tropy project first.',
                    elapsedMs: Date.now() - start,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        db = new Database(dbPath, { readonly: true, fileMustExist: true });

        const like = `%${query}%`;
        const rows = db
          .prepare(
            `SELECT sc.id AS chunk_id, sc.content AS content, sc.chunk_index AS chunk_index,
                    ps.id AS source_id, ps.title AS title, ps.date AS date,
                    ps.creator AS creator, ps.archive AS archive, ps.collection AS collection
               FROM source_chunks sc
               JOIN primary_sources ps ON ps.id = sc.source_id
              WHERE sc.content LIKE ? OR ps.title LIKE ? OR ps.transcription LIKE ?
              ORDER BY ps.date DESC NULLS LAST
              LIMIT ?`
          )
          .all(like, like, like, k) as Array<{
          chunk_id: string;
          content: string;
          chunk_index: number;
          source_id: string;
          title: string;
          date: string | null;
          creator: string | null;
          archive: string | null;
          collection: string | null;
        }>;

        const items = rows.map((r) => ({
          sourceId: r.source_id,
          chunkId: r.chunk_id,
          title: r.title,
          date: r.date,
          creator: r.creator,
          archive: r.archive,
          collection: r.collection,
          content: truncate(r.content),
        }));

        logger.log({
          kind: 'tool_call',
          at: new Date().toISOString(),
          name: TOOL_NAME,
          input: { query, topK: k },
          output: {
            itemCount: items.length,
            totalChars: items.reduce((s, i) => s + i.content.length, 0),
            truncated: items.some((i) => i.content.endsWith('…')),
          },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { query, topK: k, hits: items, elapsedMs: Date.now() - start },
                null,
                2
              ),
            },
          ],
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.log({
          kind: 'tool_call',
          at: new Date().toISOString(),
          name: TOOL_NAME,
          input: { query, topK: k },
          output: { error: message },
        });
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      } finally {
        db?.close();
      }
    }
  );
}
