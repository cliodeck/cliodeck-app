/**
 * MCP client types (fusion step 4.4 + 4.4.1bis).
 *
 * Typed state machine and event shapes for external MCP servers we
 * *consume* over stdio/SSE (third-party servers the historian installs
 * and configures herself). Not to be confused with the built-in archive
 * connectors (Gallica, HAL, Europeana, FranceArchives, Transkribus),
 * which live inside *our own* MCP server as tools under
 * `backend/mcp-server/tools/` — see `docs/archive-mcp-connectors.md`.
 * Mirrors the claw-code lesson 6.1: every long-lived component exposes
 * a typed state, never a boolean `connected`. Every transition is
 * emitted as a typed event, never scraped from logs (lesson 6.2).
 */

export type MCPClientState =
  | 'unconfigured'
  | 'spawning'
  | 'handshaking'
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'stopped';

export interface MCPClientError {
  code: string;
  message: string;
  at: string;
}

export type MCPTransportConfig =
  | {
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      transport: 'sse';
      url: string;
      headers?: Record<string, string>;
    };

export interface MCPClientConfig {
  name: string;
  description?: string;
  config: MCPTransportConfig;
  /** Whether this client starts automatically with the workspace. */
  autoStart?: boolean;
}

export interface MCPToolDescriptor {
  name: string;
  description?: string;
  /** JSON Schema for the tool's input. */
  inputSchema?: Record<string, unknown>;
}

export interface MCPClientInstance {
  name: string;
  state: MCPClientState;
  lastError?: MCPClientError;
  lastReadyAt?: string;
  tools: MCPToolDescriptor[];
  /** Monotonic transition counter — useful for React keys / change detection. */
  generation: number;
}

export type MCPClientEvent =
  | {
      kind: 'state_changed';
      at: string;
      name: string;
      from: MCPClientState;
      to: MCPClientState;
      reason?: string;
    }
  | {
      kind: 'tools_updated';
      at: string;
      name: string;
      tools: MCPToolDescriptor[];
    }
  | {
      kind: 'error';
      at: string;
      name: string;
      error: MCPClientError;
    }
  | {
      kind: 'tool_call';
      at: string;
      name: string;
      tool: string;
      durationMs: number;
      ok: boolean;
      errorCode?: string;
    };

export type MCPClientEventKind = MCPClientEvent['kind'];
