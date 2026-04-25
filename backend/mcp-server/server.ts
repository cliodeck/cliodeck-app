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
import { registerSearchHal } from './tools/searchHal.js';
import { registerSearchEuropeana } from './tools/searchEuropeana.js';

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
  // HAL (CNRS/CCSD) — public Solr endpoint, no key, secondary literature.
  registerSearchHal(server, cfg, logger);
  // Europeana — requires a free API key. Read at *call* time from
  // EUROPEANA_API_KEY env var so the user can configure / rotate / unset
  // without restarting the server. The Electron app (when it spawns this
  // server itself) propagates the key from secureStorage via env. When
  // a third-party MCP client (Claude Desktop) spawns the server, the user
  // sets the env var in their client config — see docs/archive-mcp-connectors.md.
  registerSearchEuropeana(server, cfg, logger, {
    getApiKey: () => process.env.EUROPEANA_API_KEY ?? null,
  });

  console.error(`[ClioDeck MCP] Server created for workspace ${cfg.workspaceRoot}`);
  console.error(`[ClioDeck MCP] Audit log: ${cfg.paths.mcpAccessLog}`);
  console.error(
    `[ClioDeck MCP] Tools: search_obsidian, search_zotero, search_documents, search_tropy, graph_neighbors, entity_context, search_gallica, search_hal, search_europeana`
  );

  return { server, logger };
}
