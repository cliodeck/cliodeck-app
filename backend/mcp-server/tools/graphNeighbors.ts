/**
 * graph_neighbors — MCP tool returning neighbors of a document in the
 * knowledge graph (fusion step 2.6).
 *
 * We avoid loading `KnowledgeGraphBuilder` for a single-document lookup
 * and instead query the `document_citations` and `document_similarities`
 * tables in `<workspaceRoot>/.cliodeck/vectors.db` directly. Outbound
 * edges (this doc cites X) and inbound edges (Y cites this doc) are
 * both returned, plus the top-K pre-computed similarity neighbors when
 * available.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { MCPAccessLogger } from '../logger.js';
import type { MCPRuntimeConfig } from '../config.js';

const TOOL_NAME = 'graph_neighbors';
const TRUNCATE = 800;

function truncate(s: string | null | undefined): string {
  if (!s) return '';
  return s.length > TRUNCATE ? s.slice(0, TRUNCATE) + '…' : s;
}

export function registerGraphNeighbors(
  server: McpServer,
  cfg: MCPRuntimeConfig,
  logger: MCPAccessLogger
): void {
  server.tool(
    TOOL_NAME,
    'Return the neighbors of a document in the knowledge graph: citations out, citations in, and pre-computed similarity neighbors.',
    {
      documentId: z
        .string()
        .min(1)
        .describe('Document id (as stored in vectors.db `documents.id`).'),
      topK: z.number().int().min(1).max(50).optional().default(10),
    },
    async ({ documentId, topK }) => {
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
            input: { documentId, topK: k },
            output: { itemCount: 0 },
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    documentId,
                    note: 'No vectors.db found. Index the corpus first.',
                    neighbors: [],
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

        const self = db
          .prepare(
            'SELECT id, title, author, year FROM documents WHERE id = ?'
          )
          .get(documentId) as
          | { id: string; title: string; author: string | null; year: string | null }
          | undefined;

        // Outbound: this doc cites X
        const out = db
          .prepare(
            `SELECT dc.target_doc_id AS id, dc.target_citation AS citation,
                    dc.context AS context, dc.page_number AS page,
                    d.title AS title, d.author AS author, d.year AS year
               FROM document_citations dc
          LEFT JOIN documents d ON d.id = dc.target_doc_id
              WHERE dc.source_doc_id = ?
              LIMIT ?`
          )
          .all(documentId, k) as Array<any>;

        // Inbound: Y cites this doc
        const incoming = db
          .prepare(
            `SELECT dc.source_doc_id AS id, dc.context AS context,
                    dc.page_number AS page,
                    d.title AS title, d.author AS author, d.year AS year
               FROM document_citations dc
               JOIN documents d ON d.id = dc.source_doc_id
              WHERE dc.target_doc_id = ?
              LIMIT ?`
          )
          .all(documentId, k) as Array<any>;

        // Similarity neighbors (pre-computed, may be empty if never ran).
        let similar: Array<any> = [];
        const hasSim = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='document_similarities'"
          )
          .get();
        if (hasSim) {
          similar = db
            .prepare(
              `SELECT CASE WHEN doc_id_1 = ? THEN doc_id_2 ELSE doc_id_1 END AS id,
                      similarity
                 FROM document_similarities
                WHERE doc_id_1 = ? OR doc_id_2 = ?
                ORDER BY similarity DESC
                LIMIT ?`
            )
            .all(documentId, documentId, documentId, k) as Array<{
            id: string;
            similarity: number;
          }>;

          // Decorate with titles
          const titleStmt = db.prepare(
            'SELECT id, title, author, year FROM documents WHERE id = ?'
          );
          similar = similar.map((s) => ({
            ...s,
            ...(titleStmt.get(s.id) as object | undefined),
          }));
        }

        const outbound = out.map((r) => ({
          id: r.id,
          title: r.title ?? null,
          author: r.author ?? null,
          year: r.year ?? null,
          citation: r.citation,
          page: r.page,
          context: truncate(r.context),
        }));
        const inbound = incoming.map((r) => ({
          id: r.id,
          title: r.title,
          author: r.author,
          year: r.year,
          page: r.page,
          context: truncate(r.context),
        }));

        logger.log({
          kind: 'tool_call',
          at: new Date().toISOString(),
          name: TOOL_NAME,
          input: { documentId, topK: k },
          output: {
            itemCount: outbound.length + inbound.length + similar.length,
            truncated:
              outbound.some((o) => (o.context ?? '').endsWith('…')) ||
              inbound.some((i) => (i.context ?? '').endsWith('…')),
          },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  documentId,
                  self: self ?? null,
                  outbound,
                  inbound,
                  similar,
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
          input: { documentId, topK: k },
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
