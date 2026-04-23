/**
 * search_documents — MCP tool exposing the full-text content of indexed
 * PDF chunks.
 *
 * Complements `search_zotero`, which only queries bibliographic metadata
 * (title / author / bibtexKey). Without this tool, an MCP client could
 * find WHICH documents exist in the workspace but not answer questions
 * about WHAT they say. "Greiser" never appears in the Lester diary
 * titles — it lives inside the chunks.
 *
 * Lexical-only (LIKE on `chunks.content`) by design, matching the rest
 * of this MCP server: keeps the binary standalone and free of an
 * Ollama dependency at query time. A hybrid/dense variant can be added
 * in a follow-up by wiring an embedding provider into MCPRuntimeConfig.
 *
 * Reads `<workspaceRoot>/.cliodeck/vectors.db` in read-only mode —
 * same source as `search_zotero` and `graph_neighbors`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { MCPAccessLogger } from '../logger.js';
import type { MCPRuntimeConfig } from '../config.js';

const TOOL_NAME = 'search_documents';
const TRUNCATE = 800;

function truncate(s: string | null | undefined): string {
  if (!s) return '';
  return s.length > TRUNCATE ? s.slice(0, TRUNCATE) + '…' : s;
}

export function registerSearchDocuments(
  server: McpServer,
  cfg: MCPRuntimeConfig,
  logger: MCPAccessLogger
): void {
  server.tool(
    TOOL_NAME,
    'Lexical search across the full text of indexed PDF chunks (the actual contents, not just titles/authors). Returns the top-K matching chunks with their parent document metadata.',
    {
      query: z
        .string()
        .min(1)
        .describe('Search terms matched case-insensitively against chunk content.'),
      year: z
        .string()
        .optional()
        .describe('Optional filter on the parent document year (exact match).'),
      author: z
        .string()
        .optional()
        .describe('Optional filter on the parent document author (case-insensitive substring).'),
      topK: z.number().int().min(1).max(50).optional().default(10),
    },
    async ({ query, year, author, topK }) => {
      const start = Date.now();
      const k = topK ?? 10;
      const dbPath = path.join(cfg.workspaceRoot, '.cliodeck', 'vectors.db');
      let db: Database.Database | null = null;

      try {
        if (!fs.existsSync(dbPath)) {
          logger.log({
            kind: 'tool_call',
            at: new Date().toISOString(),
            name: TOOL_NAME,
            input: { query, year, author, topK: k },
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
                    note: 'No vectors.db found. Index PDFs in ClioDeck first.',
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

        // A freshly-created vectors.db may not yet have the chunks table.
        const hasChunks = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'"
          )
          .get();
        if (!hasChunks) {
          logger.log({
            kind: 'tool_call',
            at: new Date().toISOString(),
            name: TOOL_NAME,
            input: { query, year, author, topK: k },
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
                    note: 'vectors.db present but no `chunks` table. Index PDFs first.',
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
        const params: unknown[] = [like];
        let sql =
          'SELECT c.id AS chunk_id, c.document_id, c.content, c.page_number, c.chunk_index, ' +
          '       d.title, d.author, d.year, d.bibtex_key, d.file_path ' +
          'FROM chunks c JOIN documents d ON d.id = c.document_id ' +
          'WHERE c.content LIKE ? COLLATE NOCASE';

        if (year) {
          sql += ' AND d.year = ?';
          params.push(year);
        }
        if (author) {
          sql += ' AND d.author LIKE ? COLLATE NOCASE';
          params.push(`%${author}%`);
        }

        // Rank: occurrence count of the query inside the chunk content.
        // Cheap to compute in SQL, good enough for a lexical tool — a
        // chunk that mentions the term three times is more useful than
        // one with a passing reference.
        sql +=
          " ORDER BY " +
          "   (LENGTH(c.content) - LENGTH(REPLACE(LOWER(c.content), LOWER(?), ''))) DESC, " +
          "   d.year DESC, d.title ASC, c.chunk_index ASC " +
          " LIMIT ?";
        params.push(query, k);

        const rows = db.prepare(sql).all(...params) as Array<{
          chunk_id: string;
          document_id: string;
          content: string;
          page_number: number;
          chunk_index: number;
          title: string;
          author: string | null;
          year: string | null;
          bibtex_key: string | null;
          file_path: string | null;
        }>;

        const items = rows.map((r) => ({
          chunkId: r.chunk_id,
          documentId: r.document_id,
          docTitle: r.title,
          docAuthor: r.author ?? null,
          docYear: r.year ?? null,
          bibtexKey: r.bibtex_key ?? null,
          filePath: r.file_path ?? null,
          pageNumber: r.page_number,
          chunkIndex: r.chunk_index,
          content: truncate(r.content),
        }));

        logger.log({
          kind: 'tool_call',
          at: new Date().toISOString(),
          name: TOOL_NAME,
          input: { query, year, author, topK: k },
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
                {
                  query,
                  year,
                  author,
                  topK: k,
                  hits: items,
                  elapsedMs: Date.now() - start,
                },
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
          input: { query, year, author, topK: k },
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
