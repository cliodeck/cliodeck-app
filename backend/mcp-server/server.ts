/**
 * ClioDeck MCP server (fusion step 2.5).
 *
 * Exposes the workspace's Obsidian vault to MCP clients (Claude Desktop,
 * Cursor, etc.) over stdio. Inactive by default — the config gate in
 * `loadMCPConfig` refuses to start unless the historian explicitly enables
 * the server in `.cliodeck/config.json`.
 *
 * Scope of this scaffold:
 *   - One tool: `search_obsidian` (lexical / FTS5).
 *   - Typed access log via `MCPAccessLogger` writing
 *     `.cliodeck/mcp-access.jsonl`.
 *   - Resources / prompts / additional tools (Zotero, Tropy, graph,
 *     dense search) arrive in follow-up commits.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCPAccessLogger } from './logger.js';
import { checkToolCall, isToolEnabled, type MCPRuntimeConfig } from './config.js';
import { workspaceLinkOutsideSync } from '../core/workspace/link-guard.js';
import { registerSearchObsidian } from './tools/searchObsidian.js';
import { registerSearchZotero } from './tools/searchZotero.js';
import { registerSearchDocuments } from './tools/searchDocuments.js';
import { registerSearchTropy } from './tools/searchTropy.js';
import { registerGraphNeighbors } from './tools/graphNeighbors.js';
import { registerEntityContext } from './tools/entityContext.js';
import { registerSearchGallica } from './tools/searchGallica.js';
import { registerSearchHal } from './tools/searchHal.js';
import { registerSearchEuropeana } from './tools/searchEuropeana.js';
import { registerManuscriptTools } from './tools/manuscript.js';

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

  gateToolCalls(server, cfg, logger);

  // Opt-in par outil : un outil refusé n'est pas enregistré du tout, donc le
  // client ne le voit pas. Refuser à l'appel aurait laissé le nom, la
  // description et le schéma visibles — soit déjà une fuite sur le contenu
  // du projet.
  const exposed: string[] = [];
  const register = (name: string, fn: () => void): void => {
    if (!isToolEnabled(cfg.mcp, name)) return;
    fn();
    exposed.push(name);
  };

  register('search_obsidian', () => registerSearchObsidian(server, cfg, logger));
  register('search_zotero', () => registerSearchZotero(server, cfg, logger));
  register('search_documents', () => registerSearchDocuments(server, cfg, logger));
  register('search_tropy', () => registerSearchTropy(server, cfg, logger));
  register('graph_neighbors', () => registerGraphNeighbors(server, cfg, logger));
  register('entity_context', () => registerEntityContext(server, cfg, logger));
  // Gallica (BnF) — public SRU endpoint, no key, shipped active by default.
  register('search_gallica', () => registerSearchGallica(server, cfg, logger));
  // HAL (CNRS/CCSD) — public Solr endpoint, no key, secondary literature.
  register('search_hal', () => registerSearchHal(server, cfg, logger));
  // Europeana — requires a free API key. Read at *call* time from
  // EUROPEANA_API_KEY env var so the user can configure / rotate / unset
  // without restarting the server. The Electron app (when it spawns this
  // server itself) propagates the key from secureStorage via env. When
  // a third-party MCP client (Claude Desktop) spawns the server, the user
  // sets the env var in their client config — see docs/archive-mcp-connectors.md.
  register('search_europeana', () =>
    registerSearchEuropeana(server, cfg, logger, {
      getApiKey: () => process.env.EUROPEANA_API_KEY ?? null,
    })
  );

  // Le manuscrit : deux outils, un seul accord. Les enregistrer séparément
  // laisserait un client voir la liste des chapitres sans pouvoir les lire —
  // or la liste des titres est déjà une information sur le travail en cours.
  if (isToolEnabled(cfg.mcp, 'list_manuscript') && isToolEnabled(cfg.mcp, 'read_manuscript')) {
    registerManuscriptTools(server, cfg, logger);
    exposed.push('list_manuscript', 'read_manuscript');
  }

  console.error(`[ClioDeck MCP] Server created for workspace ${cfg.workspaceRoot}`);
  console.error(`[ClioDeck MCP] Audit log: ${cfg.paths.mcpAccessLog}`);
  console.error(`[ClioDeck MCP] Tools: ${exposed.join(', ') || '(aucun)'}`);

  return { server, logger };
}

type ToolHandler = (...args: unknown[]) => unknown;

/**
 * Chaque appel d'outil repasse par l'accord du projet, relu sur disque
 * (`checkToolCall`) : l'enregistrement, lui, reste figé au démarrage. D'où
 * l'asymétrie que le panneau dit : un outil ajouté vaut au prochain
 * démarrage, un accord retiré au prochain appel. La liste annoncée au client
 * (`tools/list`) garde les outils déjà vus jusqu'à son redémarrage ; seul
 * l'appel est refusé.
 *
 * On enveloppe les deux portes d'enregistrement du SDK sur l'instance —
 * `tool` (dépréciée, celle des outils actuels) et `registerTool` (qui la
 * remplace) — plutôt que chaque outil : aucun fichier d'outil n'a à s'en
 * souvenir, et un outil ajouté ou migré plus tard est couvert d'office. Dans
 * les deux formes, le gestionnaire est le dernier argument. Un test appelle
 * chaque outil exposé après l'interrupteur coupé.
 */
function gateToolCalls(server: McpServer, cfg: MCPRuntimeConfig, logger: MCPAccessLogger): void {
  const target = server as unknown as Record<'tool' | 'registerTool', ToolHandler>;
  for (const method of ['tool', 'registerTool'] as const) {
    const register = target[method].bind(server);
    target[method] = (...args: unknown[]): unknown => {
      const name = args[0];
      const handler = args[args.length - 1];
      if (typeof name === 'string' && typeof handler === 'function') {
        args[args.length - 1] = gatedHandler(name, handler as ToolHandler, cfg, logger);
      }
      return register(...args);
    };
  }
}

function gatedHandler(
  name: string,
  inner: ToolHandler,
  cfg: MCPRuntimeConfig,
  logger: MCPAccessLogger
): ToolHandler {
  return (...callArgs: unknown[]): unknown => {
    const gate = checkToolCall(cfg.workspaceRoot, name);
    // `in` plutôt que `gate.ok` : sans strictNullChecks (tsconfig.node), un booléen ne discrimine pas.
    if (!('reason' in gate)) return inner(...callArgs);
    // Les arguments du client ne sont pas écrits. Et rien ne s'écrit à
    // travers un lien qui mène hors du projet (D18) : le journal serait
    // celui d'un autre.
    if (!workspaceLinkOutsideSync(cfg.workspaceRoot)) {
      logger.log({
        kind: 'tool_call',
        at: new Date().toISOString(),
        name,
        input: {},
        output: { error: `tool_refused: ${gate.reason}` },
      });
    }
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: 'tool_refused', reason: gate.reason }),
        },
      ],
    };
  };
}
