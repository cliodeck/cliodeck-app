/**
 * MCP server config (fusion step 2.5).
 *
 * Standalone config reader that runs without Electron — the MCP server is
 * invoked from a separate Node process (Claude Desktop spawns it via
 * stdio). Reads the workspace config to find the data dir and the
 * mcp-server enable flag.
 *
 * **Inactive by default.** The plan's ethics line is load-bearing here:
 * the server refuses to start unless `mcpServer.enabled === true` is
 * explicitly set in `.cliodeck/config.json`. This is a config-level
 * gate, not just a runtime flag — accidentally launching the binary
 * without prior consent of the historian must fail loud.
 */

import fs from 'fs';
import path from 'path';
import {
  workspaceFiles,
  workspacePaths,
  type WorkspaceFiles,
} from '../core/workspace/layout.js';
import {
  WORKSPACE_SCHEMA_VERSION,
  type WorkspaceConfig,
} from '../core/workspace/config.js';

export interface MCPServerSettings {
  enabled: boolean;
  /** Workspace-friendly name surfaced to Claude Desktop on connect. */
  serverName?: string;
  /**
   * Opt-in par outil. Absent ou `true` = exposé ; `false` = pas enregistré,
   * donc invisible du client — pas seulement refusé à l'appel.
   *
   * L'absence vaut consentement pour une raison de compatibilité : les
   * projets qui avaient déjà activé le serveur avant cette garde exposaient
   * les neuf outils, et la garde ne doit pas les couper en silence à la
   * mise à jour. Le nouveau réglage sert au cran suivant — la lecture du
   * manuscrit, que l'historien doit accorder exprès.
   */
  tools?: Record<string, boolean>;
}

/** Tous les outils que le serveur sait exposer, dans l'ordre du panneau. */
export const MCP_TOOL_NAMES = [
  'search_documents',
  'search_obsidian',
  'search_tropy',
  'search_zotero',
  'graph_neighbors',
  'entity_context',
  'search_gallica',
  'search_hal',
  'search_europeana',
  'list_manuscript',
  'read_manuscript',
] as const;

export type MCPToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * Outils qui exigent un accord explicite : leur absence du réglage vaut
 * refus, à l'inverse de tous les autres.
 *
 * Les outils de recherche exposent un index de sources publiées et des
 * archives déjà rassemblées ; ces deux-là donnent le texte inédit de
 * l'historien, mot pour mot, à un logiciel tiers. Ce n'est pas le même
 * geste, et il ne doit pas s'attraper par défaut au fil d'une mise à jour.
 */
export const TOOLS_REQUIRING_CONSENT: ReadonlySet<string> = new Set([
  'list_manuscript',
  'read_manuscript',
]);

/**
 * Un outil est exposé sauf refus explicite — sauf ceux de
 * `TOOLS_REQUIRING_CONSENT`, refusés sauf accord explicite.
 */
export function isToolEnabled(mcp: MCPServerSettings, name: string): boolean {
  const explicit = mcp.tools?.[name];
  if (typeof explicit === 'boolean') return explicit;
  return !TOOLS_REQUIRING_CONSENT.has(name);
}

export interface MCPRuntimeConfig {
  workspaceRoot: string;
  paths: WorkspaceFiles;
  workspace: WorkspaceConfig;
  mcp: MCPServerSettings;
}

/**
 * Read and gate-check the MCP runtime config for a given workspace.
 *
 * Throws if:
 *   - the workspace config is missing or unreadable;
 *   - the workspace still uses the pre-flatten `.cliodeck/v2/` layout (open in
 *     ClioDeck once to auto-migrate);
 *   - the schema version is wrong;
 *   - mcpServer.enabled is not `true` (default refusal).
 */
export function loadMCPConfig(workspaceRoot: string): MCPRuntimeConfig {
  const abs = path.resolve(workspaceRoot);
  const paths = workspaceFiles(abs);
  const legacyV2Config = path.join(workspacePaths(abs).legacyV2Dir, 'config.json');

  if (!fs.existsSync(paths.config)) {
    if (fs.existsSync(legacyV2Config)) {
      throw new Error(
        `Workspace at ${abs} still uses the legacy .cliodeck/v2/ layout. ` +
          `Open it once in ClioDeck to auto-migrate to the flat layout, then retry.`,
      );
    }
    throw new Error(
      `No ClioDeck workspace at ${abs} (expected ${paths.config}). Open it in the app first.`
    );
  }

  const raw = fs.readFileSync(paths.config, 'utf8');
  const cfg = JSON.parse(raw) as WorkspaceConfig & {
    mcpServer?: MCPServerSettings;
  };

  if (cfg.schema_version !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported workspace schema_version ${cfg.schema_version} (expected ${WORKSPACE_SCHEMA_VERSION}).`
    );
  }

  const mcp = cfg.mcpServer ?? { enabled: false };

  if (!mcp.enabled) {
    throw new Error(
      [
        'MCP server is disabled for this workspace.',
        'Set `mcpServer.enabled: true` in `.cliodeck/config.json` to allow',
        'external clients (e.g. Claude Desktop) to read the corpus.',
        'This is intentional: the historian must opt-in explicitly.',
      ].join('\n')
    );
  }

  return {
    workspaceRoot: abs,
    paths,
    workspace: cfg,
    mcp,
  };
}
