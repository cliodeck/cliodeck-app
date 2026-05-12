/**
 * entity_context — MCP tool returning mentions of a named entity across
 * the corpus (fusion step 2.6).
 *
 * Post db-fusion (step 3), NER tables live in the shared
 * `<workspaceRoot>/.cliodeck/brain.db` under the `tropy_` prefix:
 * `tropy_entities`, `tropy_entity_mentions`. Mentions can reference both
 * primary sources (`tropy_sources`) and — once PDF NER lands —
 * secondary documents (`pdf_documents`, today still `documents` in the
 * un-prefixed PDF vector store until step 4 of the consolidation).
 *
 * For each match: entity canonical name, type, and per-mention context
 * (chunk snippet, already persisted on `tropy_entity_mentions.context`).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { MCPAccessLogger } from '../logger.js';
import type { MCPRuntimeConfig } from '../config.js';

const TOOL_NAME = 'entity_context';
const TRUNCATE = 800;

function truncate(s: string | null | undefined): string {
  if (!s) return '';
  return s.length > TRUNCATE ? s.slice(0, TRUNCATE) + '…' : s;
}

interface Mention {
  entityId: string;
  entityName: string;
  entityType: string;
  sourceId: string;
  sourceTitle: string | null;
  sourceKind: 'primary' | 'secondary';
  chunkId: string | null;
  context: string;
}

function hasTable(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return !!row;
}

function queryPrimary(
  dbPath: string,
  entityQuery: string,
  limit: number
): Mention[] {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (
      !hasTable(db, 'tropy_entities') ||
      !hasTable(db, 'tropy_entity_mentions')
    ) {
      return [];
    }
    const like = `%${entityQuery.toLowerCase()}%`;
    const rows = db
      .prepare(
        `SELECT e.id AS entity_id, e.name AS entity_name, e.type AS entity_type,
                em.chunk_id AS chunk_id, em.source_id AS source_id,
                em.context AS context, ps.title AS source_title
           FROM tropy_entity_mentions em
           JOIN tropy_entities e ON e.id = em.entity_id
      LEFT JOIN tropy_sources ps ON ps.id = em.source_id
          WHERE e.normalized_name LIKE ? OR LOWER(e.name) LIKE ?
          LIMIT ?`
      )
      .all(like, like, limit) as Array<any>;
    return rows.map((r) => ({
      entityId: r.entity_id,
      entityName: r.entity_name,
      entityType: r.entity_type,
      sourceId: r.source_id,
      sourceTitle: r.source_title ?? null,
      sourceKind: 'primary' as const,
      chunkId: r.chunk_id ?? null,
      context: truncate(r.context),
    }));
  } finally {
    db.close();
  }
}

function querySecondary(
  dbPath: string,
  entityQuery: string,
  limit: number
): Mention[] {
  // Reads PDF-side entity tables from vectors.db. These still use the
  // unprefixed legacy names until db-fusion step 4 brings them into brain.db
  // with `pdf_` prefixes. Silently return [] if the tables aren't there yet.
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (!hasTable(db, 'entities') || !hasTable(db, 'entity_mentions')) {
      return [];
    }
    const like = `%${entityQuery.toLowerCase()}%`;
    const rows = db
      .prepare(
        `SELECT e.id AS entity_id, e.name AS entity_name, e.type AS entity_type,
                em.chunk_id AS chunk_id, em.source_id AS source_id,
                em.context AS context, d.title AS source_title
           FROM entity_mentions em
           JOIN entities e ON e.id = em.entity_id
      LEFT JOIN documents d ON d.id = em.source_id
          WHERE e.normalized_name LIKE ? OR LOWER(e.name) LIKE ?
          LIMIT ?`
      )
      .all(like, like, limit) as Array<any>;
    return rows.map((r) => ({
      entityId: r.entity_id,
      entityName: r.entity_name,
      entityType: r.entity_type,
      sourceId: r.source_id,
      sourceTitle: r.source_title ?? null,
      sourceKind: 'secondary' as const,
      chunkId: r.chunk_id ?? null,
      context: truncate(r.context),
    }));
  } finally {
    db.close();
  }
}

export function registerEntityContext(
  server: McpServer,
  cfg: MCPRuntimeConfig,
  logger: MCPAccessLogger
): void {
  server.tool(
    TOOL_NAME,
    'Return NER-extracted mentions of a named entity across the corpus. Yields document titles and chunk-level context snippets.',
    {
      entity: z
        .string()
        .min(1)
        .describe('Entity name to look up (fuzzy match on normalized name).'),
      topK: z.number().int().min(1).max(50).optional().default(10),
    },
    async ({ entity, topK }) => {
      const start = Date.now();
      const k = topK ?? 10;
      const primaryDb = path.join(cfg.workspaceRoot, '.cliodeck', 'brain.db');
      const secondaryDb = path.join(
        cfg.workspaceRoot,
        '.cliodeck',
        'vectors.db'
      );
      try {
        const mentions = [
          ...queryPrimary(primaryDb, entity, k),
          ...querySecondary(secondaryDb, entity, k),
        ].slice(0, k);

        const note =
          mentions.length === 0
            ? 'No mentions found. NER tables (tropy_entities, tropy_entity_mentions) may be missing — run the entity extraction pipeline.'
            : undefined;

        logger.log({
          kind: 'tool_call',
          at: new Date().toISOString(),
          name: TOOL_NAME,
          input: { entity, topK: k },
          output: {
            itemCount: mentions.length,
            totalChars: mentions.reduce((s, m) => s + m.context.length, 0),
            truncated: mentions.some((m) => m.context.endsWith('…')),
          },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  entity,
                  topK: k,
                  mentions,
                  note,
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
          input: { entity, topK: k },
          output: { error: message },
        });
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
