/**
 * ClioDeck MCP server (fusion step 2.5).
 *
 * Exposes the workspace's Obsidian vault to MCP clients (Claude Desktop,
 * Cursor, etc.) over stdio. Inactive by default — the config gate in
 * `loadMCPConfig` refuses to start unless the historian explicitly enables
 * the server in `.cliodeck/v2/config.json`.
 *
 * Scope of this scaffold:
 *   - One tool: `search_obsidian` (lexical / FTS5).
 *   - Typed access log via `MCPAccessLogger` writing
 *     `.cliodeck/v2/mcp-access.jsonl`.
 *   - Resources / prompts / additional tools (Zotero, Tropy, graph,
 *     dense search) arrive in follow-up commits.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCPAccessLogger } from './logger.js';
import type { MCPRuntimeConfig } from './config.js';
import { registerSearchObsidian } from './tools/searchObsidian.js';
import { registerSearchZotero } from './tools/searchZotero.js';
import { registerSearchDocuments } from './tools/searchDocuments.js';
import { registerSearchTropy } from './tools/searchTropy.js';
import { registerGraphNeighbors } from './tools/graphNeighbors.js';
import { registerEntityContext } from './tools/entityContext.js';
import { registerSearchGallica } from './tools/searchGallica.js';

const SERVER_NAME = 'cliodeck';
const SERVER_VERSION = '0.1.0';

export interface ClioDeckMcpServer {
  server: McpServer;
  logger: MCPAccessLogger;
}

export function createMcpServer(cfg: MCPRuntimeConfig): ClioDeckMcpServer {
  const server = new McpServer({
    name: cfg.mcp.serverName ?? SERVER_NAME,
    version: SERVER_VERSION,
  });

  const logger = new MCPAccessLogger(cfg.paths.mcpAccessLog);
  logger.open();

  registerSearchObsidian(server, cfg, logger);
  registerSearchZotero(server, cfg, logger);
  registerSearchDocuments(server, cfg, logger);
  registerSearchTropy(server, cfg, logger);
  registerGraphNeighbors(server, cfg, logger);
  registerEntityContext(server, cfg, logger);
  // Gallica (BnF) — public SRU endpoint, no key, shipped active by default.
  registerSearchGallica(server, cfg, logger);

  console.error(`[ClioDeck MCP] Server created for workspace ${cfg.workspaceRoot}`);
  console.error(`[ClioDeck MCP] Audit log: ${cfg.paths.mcpAccessLog}`);
  console.error(
    `[ClioDeck MCP] Tools: search_obsidian, search_zotero, search_documents, search_tropy, graph_neighbors, entity_context, search_gallica`
  );

  return { server, logger };
}
