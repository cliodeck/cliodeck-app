/**
 * search_zotero — MCP tool exposing the workspace's Zotero-derived
 * bibliography (fusion step 2.6).
 *
 * The Zotero integration populates the `documents` table of
 * `<workspaceRoot>/.cliodeck/vectors.db` with fields extracted from the
 * Zotero library (title, author, year, bibtex_key). We do NOT parse
 * `.bib` files directly — too brittle. A dedicated `bibliography.db` is
 * listed in the fusion plan but not yet shipped; when it materialises
 * we can swap the source without changing the tool surface.
 *
 * Lexical filter across title/author (case-insensitive LIKE) plus
 * optional year filter. No FTS yet — bibliography rows are short, LIKE
 * on an indexable field is plenty for bibliographic lookup.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { MCPAccessLogger } from '../logger.js';
import type { MCPRuntimeConfig } from '../config.js';

const TOOL_NAME = 'search_zotero';
const TRUNCATE = 800;

function truncate(s: string | null | undefined): string {
  if (!s) return '';
  return s.length > TRUNCATE ? s.slice(0, TRUNCATE) + '…' : s;
}

export function registerSearchZotero(
  server: McpServer,
  cfg: MCPRuntimeConfig,
  logger: MCPAccessLogger
): void {
  server.tool(
    TOOL_NAME,
    'Search the workspace bibliography (Zotero-derived) by author / title / year / tag. Returns matching bibliographic records.',
    {
      query: z
        .string()
        .min(1)
        .describe('Search terms (matched against title, author, bibtex key).'),
      year: z
        .string()
        .optional()
        .describe('Optional year filter (exact match).'),
      topK: z.number().int().min(1).max(50).optional().default(10),
    },
    async ({ query, year, topK }) => {
      const start = Date.now();
      const k = topK ?? 10;
      const dbPath = path.join(cfg.workspaceRoot, '.cliodeck', 'vectors.db');
      // Alternative source (listed in fusion plan but not shipped yet).
      const bibDbPath = path.join(
        cfg.workspaceRoot,
        '.cliodeck',
        'bibliography.db'
      );
      let db: Database.Database | null = null;
      try {
        if (!fs.existsSync(dbPath) && !fs.existsSync(bibDbPath)) {
          logger.log({
            kind: 'tool_call',
            at: new Date().toISOString(),
            name: TOOL_NAME,
            input: { query, year, topK: k },
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
                    note: 'No bibliography database found (.cliodeck/vectors.db or .cliodeck/bibliography.db). Index a Zotero library first.',
                    elapsedMs: Date.now() - start,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Prefer vectors.db (shipped today); bibliography.db remains a stub.
        const source = fs.existsSync(dbPath) ? dbPath : bibDbPath;
        db = new Database(source, { readonly: true, fileMustExist: true });

        // Confirm the documents table exists — a freshly created db may not
        // have it yet.
        const hasDocs = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'"
          )
          .get();
        if (!hasDocs) {
          logger.log({
            kind: 'tool_call',
            at: new Date().toISOString(),
            name: TOOL_NAME,
            input: { query, year, topK: k },
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
                    note: 'Bibliography database present but no `documents` table. Run the Zotero indexer.',
                    elapsedMs: Date.now() - start,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const like = `%${query}%`;
        const params: any[] = [like, like, like];
        let sql =
          'SELECT id, title, author, year, bibtex_key, file_path, summary ' +
          'FROM documents WHERE (title LIKE ? OR author LIKE ? OR bibtex_key LIKE ?)';
        if (year) {
          sql += ' AND year = ?';
          params.push(year);
        }
        sql += ' ORDER BY year DESC, title ASC LIMIT ?';
        params.push(k);

        const rows = db.prepare(sql).all(...params) as Array<{
          id: string;
          title: string;
          author: string | null;
          year: string | null;
          bibtex_key: string | null;
          file_path: string | null;
          summary: string | null;
        }>;

        const items = rows.map((r) => ({
          id: r.id,
          title: truncate(r.title),
          author: r.author ?? null,
          year: r.year ?? null,
          bibtexKey: r.bibtex_key ?? null,
          filePath: r.file_path ?? null,
          summary: truncate(r.summary),
        }));

        logger.log({
          kind: 'tool_call',
          at: new Date().toISOString(),
          name: TOOL_NAME,
          input: { query, year, topK: k },
          output: {
            itemCount: items.length,
            totalChars: items.reduce(
              (s, i) => s + (i.title?.length ?? 0) + (i.summary?.length ?? 0),
              0
            ),
            truncated: items.some(
              (i) =>
                (i.title && i.title.endsWith('…')) ||
                (i.summary && i.summary.endsWith('…'))
            ),
          },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { query, year, topK: k, hits: items, elapsedMs: Date.now() - start },
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
          input: { query, year, topK: k },
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
