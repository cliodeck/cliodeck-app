/**
 * Real MCPClientHandle factory backed by @modelcontextprotocol/sdk.
 *
 * Bridges the `MCPClientConfig` shape the manager expects to the SDK's
 * `Client` + `StdioClientTransport` / `SSEClientTransport`. Handles:
 *   - transport lifecycle (spawn subprocess, close pipes, abort SSE)
 *   - typed error mapping to the manager's `MCPClientError`
 *   - onCrash subscription so the manager can trigger its one silent retry
 *
 * The manager owns state transitions; the factory is transport-dumb.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type {
  MCPClientConfig,
  MCPClientError,
  MCPToolDescriptor,
} from './types.js';
import type { MCPClientHandle, MCPClientFactory } from './manager.js';
import { buildMCPSpawnEnv } from './env-filter.js';

const CLIENT_INFO = { name: 'cliodeck', version: '2.0.0' };

function now(): string {
  return new Date().toISOString();
}

function toErr(code: string, e: unknown): MCPClientError {
  return {
    code,
    message: e instanceof Error ? e.message : String(e),
    at: now(),
  };
}

export const realMCPClientFactory: MCPClientFactory = (
  cfg: MCPClientConfig
): MCPClientHandle => {
  let client: Client | null = null;
  let transport: StdioClientTransport | SSEClientTransport | null = null;
  const crashCallbacks: Array<(err: MCPClientError) => void> = [];
  let crashed = false;

  const fireCrash = (err: MCPClientError): void => {
    if (crashed) return;
    crashed = true;
    crashCallbacks.forEach((cb) => {
      try {
        cb(err);
      } catch {
        // ignore subscriber throws
      }
    });
  };

  return {
    async connect(): Promise<void> {
      if (cfg.config.transport === 'stdio') {
        const stdio = new StdioClientTransport({
          command: cfg.config.command,
          args: cfg.config.args ?? [],
          env: buildMCPSpawnEnv(cfg.config.env),
          cwd: cfg.config.cwd,
        });
        stdio.onerror = (err: Error): void =>
          fireCrash(toErr('transport_error', err));
        stdio.onclose = (): void =>
          fireCrash(toErr('transport_closed', 'stdio transport closed'));
        transport = stdio;
      } else {
        const sse = new SSEClientTransport(new URL(cfg.config.url), {
          requestInit: cfg.config.headers
            ? { headers: cfg.config.headers }
            : undefined,
        });
        sse.onerror = (err: Error): void =>
          fireCrash(toErr('transport_error', err));
        sse.onclose = (): void =>
          fireCrash(toErr('transport_closed', 'sse transport closed'));
        transport = sse;
      }

      client = new Client(CLIENT_INFO, {});
      await client.connect(transport);
    },

    async listTools(): Promise<MCPToolDescriptor[]> {
      if (!client) throw new Error('MCP client not connected');
      const res = await client.listTools();
      return (res.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      }));
    },

    async callTool(name, args) {
      if (!client) {
        return {
          ok: false,
          error: toErr('client_not_connected', 'MCP client not connected'),
        };
      }
      try {
        const res = await client.callTool({ name, arguments: args });
        return { ok: !res.isError, result: res };
      } catch (e) {
        return { ok: false, error: toErr('call_tool_error', e) };
      }
    },

    async close(): Promise<void> {
      try {
        await client?.close();
      } catch {
        // best effort
      }
      try {
        await transport?.close();
      } catch {
        // best effort
      }
      client = null;
      transport = null;
    },

    onCrash(cb): void {
      crashCallbacks.push(cb);
    },
  };
};
