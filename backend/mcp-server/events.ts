/**
 * MCP access events (fusion step 2.5, claw-code lesson 6.2 — *events over
 * scraped prose*).
 *
 * Every interaction the MCP server has with an external client is recorded
 * as one of these typed records, written line-by-line to
 * `.cliodeck/v2/mcp-access.jsonl`. This is the *contre-archivage* the
 * fusion plan calls for: a historian must be able to audit exactly what
 * their corpus told a third-party model, when, and which client asked.
 *
 * Output payloads are deliberately summarised (`itemCount`, `totalChars`,
 * `truncated`), never the raw content — the log is small enough to
 * preserve forever and not so big it leaks prose to anyone reading it.
 */

export type MCPInteractionKind = 'tool' | 'resource' | 'prompt';

export interface MCPOutputSummary {
  itemCount?: number;
  totalChars?: number;
  truncated?: boolean;
  error?: string;
}

export interface MCPClientInfo {
  name?: string;
  version?: string;
}

export type MCPAccessEvent =
  | {
      kind: 'tool_call';
      at: string;
      name: string;
      input: Record<string, unknown>;
      output: MCPOutputSummary;
      client?: MCPClientInfo;
    }
  | {
      kind: 'resource_read';
      at: string;
      uri: string;
      output: MCPOutputSummary;
      client?: MCPClientInfo;
    }
  | {
      kind: 'prompt_get';
      at: string;
      name: string;
      args: Record<string, unknown>;
      client?: MCPClientInfo;
    }
  | {
      kind: 'server_started';
      at: string;
      transport: 'stdio' | 'sse';
      workspace: string;
    }
  | {
      kind: 'server_stopped';
      at: string;
      reason: 'requested' | 'crash' | 'unknown';
    };

export type MCPAccessEventKind = MCPAccessEvent['kind'];
