#!/usr/bin/env node
/**
 * ClioDeck MCP server stdio entrypoint (fusion step 2.5).
 *
 * Usage:
 *   cliodeck-mcp <workspace-root>
 *
 * Spawned by an MCP client (Claude Desktop config, Cursor `mcp.json`, etc.)
 * with the workspace root as its single argument. Exits non-zero with a
 * clear stderr message when the workspace doesn't exist or the MCP server
 * is disabled in its config.
 *
 * Inactive by default: the gate lives in `loadMCPConfig`, not here. That
 * way running the binary by accident — say, a stale Claude Desktop config
 * pointing at a deleted workspace — fails loud instead of silently
 * exposing nothing.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadMCPConfig } from './config.js';
import { createMcpServer } from './server.js';

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      'Usage: cliodeck-mcp <workspace-root>\n' +
        '  workspace-root: path to a ClioDeck v2 workspace (contains .cliodeck/v2/)'
    );
    process.exit(2);
  }

  let cfg;
  try {
    cfg = loadMCPConfig(arg);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const { server, logger } = createMcpServer(cfg);

  logger.log({
    kind: 'server_started',
    at: new Date().toISOString(),
    transport: 'stdio',
    workspace: cfg.workspaceRoot,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown: SIGINT / SIGTERM / stdin close all flush a
  // `server_stopped` event so the audit log shows a clean termination.
  const stop = (reason: 'requested' | 'crash' | 'unknown'): void => {
    logger.log({
      kind: 'server_stopped',
      at: new Date().toISOString(),
      reason,
    });
    logger.close();
    process.exit(reason === 'crash' ? 1 : 0);
  };

  process.on('SIGINT', () => stop('requested'));
  process.on('SIGTERM', () => stop('requested'));
  process.on('uncaughtException', (e) => {
    console.error('[cliodeck-mcp] uncaught:', e);
    stop('crash');
  });
}

main().catch((e) => {
  console.error('[cliodeck-mcp] fatal:', e);
  process.exit(1);
});
