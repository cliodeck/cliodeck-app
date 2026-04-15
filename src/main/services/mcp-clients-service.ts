/**
 * Singleton manager for workspace MCP clients in the Electron main process.
 *
 * Responsibilities:
 *   - Read MCP client definitions from the workspace v2 config
 *     (`WorkspaceConfig.mcpClients`, flat shape) and adapt them to the
 *     manager's nested `MCPClientConfig`.
 *   - Own a single `MCPClientManager` instance with the real SDK factory.
 *   - Start clients on `loadProject()`, stop on `unload()`.
 *   - Surface events to any number of listeners (IPC handlers subscribe).
 *
 * Design: this service is intentionally thin. All lifecycle / retry logic
 * lives in `MCPClientManager`. Persistence (read/write) is delegated to
 * `readWorkspaceConfig` / `writeWorkspaceConfig` so the single source of
 * truth for workspace state stays the v2 config.json file.
 */

import { MCPClientManager } from '../../../backend/integrations/mcp-clients/manager.js';
import type {
  MCPClientConfig as ManagerClientConfig,
  MCPClientEvent,
  MCPClientInstance,
} from '../../../backend/integrations/mcp-clients/types.js';
import { realMCPClientFactory } from '../../../backend/integrations/mcp-clients/sdk-factory.js';
import {
  readWorkspaceConfig,
  writeWorkspaceConfig,
  defaultWorkspaceConfig,
  type MCPClientConfig as WorkspaceClientConfig,
  type WorkspaceConfig,
} from '../../../backend/core/workspace/config.js';
import { ensureV2Directories, v2Paths } from '../../../backend/core/workspace/layout.js';
import path from 'path';
import { createWriteStream, type WriteStream } from 'node:fs';
import { redactForAudit } from '../../../backend/mcp-server/audit.js';

export function toManagerConfig(w: WorkspaceClientConfig): ManagerClientConfig {
  if (w.transport === 'stdio') {
    if (!w.command) {
      throw new Error(`MCP client "${w.name}": stdio transport requires a command`);
    }
    return {
      name: w.name,
      config: {
        transport: 'stdio',
        command: w.command,
        args: w.args,
        env: w.env,
      },
    };
  }
  if (!w.url) {
    throw new Error(`MCP client "${w.name}": sse transport requires a url`);
  }
  return {
    name: w.name,
    config: { transport: 'sse', url: w.url },
  };
}

class MCPClientsService {
  private manager: MCPClientManager | null = null;
  private workspaceRoot: string | null = null;
  private listeners = new Set<(e: MCPClientEvent) => void>();
  private auditLogStream: WriteStream | null = null;

  private writeAuditLog(e: MCPClientEvent): void {
    if (!this.auditLogStream) return;
    try {
      // Reuse the central redaction helper so the file written by this
      // service stays in the same shape as the one written by the MCP
      // server logger (same key filtering, same env masking) — one audit
      // file, one contract.
      const redacted = redactForAudit(e);
      this.auditLogStream.write(JSON.stringify(redacted) + '\n');
    } catch (err) {
      console.warn('[mcp-clients] failed to write audit log entry:', err);
    }
  }

  private async readOrInitConfig(root: string): Promise<WorkspaceConfig> {
    await ensureV2Directories(root);
    try {
      return await readWorkspaceConfig(root);
    } catch {
      const fresh = defaultWorkspaceConfig(path.basename(root));
      await writeWorkspaceConfig(root, fresh);
      return fresh;
    }
  }

  async loadProject(root: string): Promise<void> {
    await this.unload();
    this.workspaceRoot = root;

    try {
      await ensureV2Directories(root);
      this.auditLogStream = createWriteStream(v2Paths(root).mcpAccessLog, {
        flags: 'a',
      });
      this.auditLogStream.on('error', (err) => {
        console.warn('[mcp-clients] audit log stream error:', err);
      });
    } catch (err) {
      console.warn('[mcp-clients] failed to open audit log stream:', err);
      this.auditLogStream = null;
    }

    this.manager = new MCPClientManager({
      factory: realMCPClientFactory,
      onEvent: (e) => {
        this.writeAuditLog(e);
        this.listeners.forEach((l) => {
          try {
            l(e);
          } catch {
            // ignore subscriber throws
          }
        });
      },
    });

    const cfg = await this.readOrInitConfig(root);
    const clients = cfg.mcpClients ?? [];
    for (const w of clients) {
      try {
        this.manager.register(toManagerConfig(w));
      } catch (e) {
        console.warn('[mcp-clients] skipping invalid client:', e);
      }
    }
    if (clients.length) {
      await this.manager.startAll();
    }
  }

  async unload(): Promise<void> {
    await this.manager?.stopAll();
    this.manager = null;
    this.workspaceRoot = null;
    if (this.auditLogStream) {
      try {
        this.auditLogStream.end();
      } catch (err) {
        console.warn('[mcp-clients] failed to close audit log stream:', err);
      }
      this.auditLogStream = null;
    }
  }

  list(): MCPClientInstance[] {
    return this.manager?.listAll() ?? [];
  }

  subscribe(cb: (e: MCPClientEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async addClient(client: WorkspaceClientConfig): Promise<MCPClientInstance> {
    if (!this.workspaceRoot || !this.manager) {
      throw new Error('No project loaded');
    }
    const cfg = await this.readOrInitConfig(this.workspaceRoot);
    const existing = cfg.mcpClients ?? [];
    if (existing.some((c) => c.name === client.name)) {
      throw new Error(`MCP client "${client.name}" already exists`);
    }
    cfg.mcpClients = [...existing, client];
    await writeWorkspaceConfig(this.workspaceRoot, cfg);
    this.manager.register(toManagerConfig(client));
    return this.manager.start(client.name);
  }

  async removeClient(name: string): Promise<void> {
    if (!this.workspaceRoot || !this.manager) {
      throw new Error('No project loaded');
    }
    const cfg = await this.readOrInitConfig(this.workspaceRoot);
    cfg.mcpClients = (cfg.mcpClients ?? []).filter((c) => c.name !== name);
    await writeWorkspaceConfig(this.workspaceRoot, cfg);
    await this.manager.stop(name);
  }

  async restart(name: string): Promise<MCPClientInstance | null> {
    if (!this.manager) return null;
    await this.manager.stop(name);
    return this.manager.start(name);
  }

  async callTool(
    name: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> {
    if (!this.manager) {
      return { ok: false, error: { code: 'no_manager', message: 'No project loaded' } };
    }
    const res = await this.manager.callTool(name, tool, args);
    return {
      ok: res.ok,
      result: res.result,
      error: res.error ? { code: res.error.code, message: res.error.message } : undefined,
    };
  }
}

export const mcpClientsService = new MCPClientsService();
