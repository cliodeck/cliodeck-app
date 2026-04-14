/**
 * search_obsidian — MCP tool exposing the workspace's Obsidian vault
 * (fusion step 2.5).
 *
 * Lexical-only by design (FTS5 BM25 via `ObsidianVaultStore.searchLexical`).
 * Avoids requiring a running Ollama just to answer an MCP query — the MCP
 * server is meant to be lightweight and standalone. Hybrid search (dense
 * + lexical) lands in a follow-up that wires an embedding provider into
 * the MCP runtime.
 *
 * Output is summarised before being returned to the model: each hit
 * carries the note's relative path, title, the chunk content (truncated
 * to 800 chars), and section title. The full chunk content stays
 * accessible to the model — the truncation only protects the audit log
 * length, not the model.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ObsidianVaultStore } from '../../integrations/obsidian/ObsidianVaultStore.js';
import { obsidianStorePath } from '../../integrations/obsidian/ObsidianVaultIndexer.js';
import type { MCPAccessLogger } from '../logger.js';
import type { MCPRuntimeConfig } from '../config.js';

const TOOL_NAME = 'search_obsidian';
const TRUNCATE = 800;

export function registerSearchObsidian(
  server: McpServer,
  cfg: MCPRuntimeConfig,
  logger: MCPAccessLogger
): void {
  server.tool(
    TOOL_NAME,
    'Lexical search across the workspace Obsidian vault. Returns the top-K matching chunks with their note path, title, and surrounding section.',
    {
      query: z.string().min(1).describe('Search query (BM25 ranked)'),
      topK: z.number().int().min(1).max(50).optional().default(10),
    },
    async ({ query, topK }) => {
      const start = Date.now();
      let store: ObsidianVaultStore | null = null;
      try {
        // ObsidianVaultStore needs a declared dimension; lexical search
        // never reads the embedding column, so any positive value works.
        store = new ObsidianVaultStore({
          dbPath: obsidianStorePath(cfg.workspaceRoot),
          dimension: 1,
        });
        const hits = store.searchLexical(query, topK ?? 10);

        const items = hits.map((h) => ({
          notePath: h.note.relativePath,
          title: h.note.title,
          section: h.chunk.sectionTitle ?? null,
          score: h.score,
          content:
            h.chunk.content.length > TRUNCATE
              ? h.chunk.content.slice(0, TRUNCATE) + '…'
              : h.chunk.content,
        }));

        logger.log({
          kind: 'tool_call',
          at: new Date().toISOString(),
          name: TOOL_NAME,
          input: { query, topK: topK ?? 10 },
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
                  topK: topK ?? 10,
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
          input: { query, topK: topK ?? 10 },
          output: { error: message },
        });
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      } finally {
        store?.close();
      }
    }
  );
}
