/**
 * MCP access logger (fusion step 2.5).
 *
 * Synchronous JSONL appender for `MCPAccessEvent`s. Synchronous on purpose:
 * MCP traffic is low-volume and an audit log must survive process crashes
 * — buffering loses the most important event right when the historian
 * needs it (the moment the server died).
 *
 * Replaces the cliobrain `McpLogger` class but with a typed event shape
 * (events.ts) so consumers (renderer audit dashboard, future CLI
 * `cliodeck mcp:audit`) reason over discriminated unions, never strings.
 */

import fs from 'fs';
import path from 'path';
import type { MCPAccessEvent } from './events.js';

export class MCPAccessLogger {
  private opened = false;

  constructor(private readonly logPath: string) {}

  open(): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      if (!fs.existsSync(this.logPath)) {
        fs.writeFileSync(this.logPath, '', 'utf8');
      }
    } catch (e) {
      // Logging failure is reported on stderr and otherwise non-fatal —
      // the MCP server should not refuse to start because the audit
      // log can't open. The user sees the warning at startup.
      console.error('[MCPAccessLogger] open failed:', e);
    }
    this.opened = true;
  }

  log(event: MCPAccessEvent): void {
    if (!this.opened) this.open();
    try {
      fs.appendFileSync(this.logPath, JSON.stringify(event) + '\n', 'utf8');
    } catch (e) {
      console.error('[MCPAccessLogger] append failed:', e);
    }
  }

  close(): void {
    this.opened = false;
  }

  get path(): string {
    return this.logPath;
  }
}
