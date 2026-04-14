/**
 * MCP server config (fusion step 2.5).
 *
 * Standalone config reader that runs without Electron — the MCP server is
 * invoked from a separate Node process (Claude Desktop spawns it via
 * stdio). Reads the workspace v2 config to find the data dir and the
 * mcp-server enable flag.
 *
 * **Inactive by default.** The plan's ethics line is load-bearing here:
 * the server refuses to start unless `mcpServer.enabled === true` is
 * explicitly set in `.cliodeck/v2/config.json`. This is a config-level
 * gate, not just a runtime flag — accidentally launching the binary
 * without prior consent of the historian must fail loud.
 */

import fs from 'fs';
import path from 'path';
import {
  v2Paths,
  type V2Paths,
} from '../core/workspace/layout.js';
import {
  WORKSPACE_SCHEMA_VERSION,
  type WorkspaceConfig,
} from '../core/workspace/config.js';

export interface MCPServerSettings {
  enabled: boolean;
  /** Workspace-friendly name surfaced to Claude Desktop on connect. */
  serverName?: string;
}

export interface MCPRuntimeConfig {
  workspaceRoot: string;
  paths: V2Paths;
  workspace: WorkspaceConfig;
  mcp: MCPServerSettings;
}

/**
 * Read and gate-check the MCP runtime config for a given workspace.
 *
 * Throws if:
 *   - the workspace v2 config is missing or unreadable;
 *   - the schema version is wrong;
 *   - mcpServer.enabled is not `true` (default refusal).
 */
export function loadMCPConfig(workspaceRoot: string): MCPRuntimeConfig {
  const abs = path.resolve(workspaceRoot);
  const paths = v2Paths(abs);

  if (!fs.existsSync(paths.config)) {
    throw new Error(
      `No ClioDeck v2 workspace at ${abs} (expected ${paths.config}). Open it in the app first.`
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
        'Set `mcpServer.enabled: true` in `.cliodeck/v2/config.json` to allow',
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
