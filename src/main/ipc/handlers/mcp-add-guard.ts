/**
 * Security guard for `fusion:mcp:add` (see RCE mitigation task).
 *
 * The IPC handler accepts a stdio command + args + env from the renderer and
 * spawns it via `StdioClientTransport`. A compromised renderer (XSS, malicious
 * dep, RAG-injected content) could therefore achieve RCE. This module provides
 * the three pre-spawn checks:
 *
 *   1. Whitelist the `command` (known interpreters or validated absolute paths).
 *   2. Sanitize the `env` map (key shape + no control chars in values).
 *   3. Require a native confirmation dialog from the user in the main process.
 *
 * Separation of concerns: env-value whitelisting (e.g. secret-redaction) is
 * handled downstream in `sdk-factory.ts` per the sibling task and is NOT done
 * here.
 *
 * The module also exposes an append-only audit writer for `mcp-access.jsonl`
 * so every accept/deny is recorded regardless of outcome.
 */

import path from 'path';
import fs from 'fs/promises';
import type { Dialog } from 'electron';

/** Interpreters allowed as bare (un-pathed) commands. */
export const ALLOWED_BARE_COMMANDS = new Set<string>([
  'npx',
  'node',
  'python',
  'python3',
  'uvx',
]);

const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
// Control chars: ASCII 0x00–0x1F and 0x7F. Allow nothing outside printable.
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/;

export interface McpAddRequest {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export type McpAddValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate the command + env of an incoming stdio MCP add request. SSE is
 * handled separately (no spawn, only a URL to open).
 */
export function validateMcpAddRequest(req: McpAddRequest): McpAddValidation {
  if (req.transport !== 'stdio') return { ok: true };

  const cmd = req.command;
  if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
    return { ok: false, reason: 'missing_command' };
  }

  // Reject embedded control chars / newlines in the command itself.
  if (CONTROL_CHARS_RE.test(cmd)) {
    return { ok: false, reason: 'command_contains_control_chars' };
  }

  if (path.isAbsolute(cmd)) {
    // Absolute paths are allowed but must not contain shell metacharacters or
    // attempt to traverse. We leave execute-bit checks to the OS at spawn.
    if (/[;&|`$<>(){}\\*?]/.test(cmd)) {
      return { ok: false, reason: 'command_contains_shell_metachars' };
    }
  } else {
    // Non-absolute: must be exactly a known bare interpreter. Relative paths
    // like `./foo` or `bin/foo` are refused.
    if (cmd.includes('/') || cmd.includes('\\')) {
      return { ok: false, reason: 'relative_path_not_allowed' };
    }
    if (!ALLOWED_BARE_COMMANDS.has(cmd)) {
      return { ok: false, reason: 'command_not_in_whitelist' };
    }
  }

  // Env key/value shape. We don't whitelist *which* env keys are allowed —
  // that's sdk-factory's job. We only reject malformed shapes.
  if (req.env) {
    for (const [k, v] of Object.entries(req.env)) {
      if (!ENV_KEY_RE.test(k)) {
        return { ok: false, reason: `env_key_invalid:${k}` };
      }
      if (typeof v !== 'string') {
        return { ok: false, reason: `env_value_not_string:${k}` };
      }
      if (CONTROL_CHARS_RE.test(v)) {
        return { ok: false, reason: `env_value_control_chars:${k}` };
      }
    }
  }

  return { ok: true };
}

export interface ConfirmOptions {
  dialog: Pick<Dialog, 'showMessageBox'>;
  parentWindow?: Electron.BrowserWindow | null;
}

/**
 * Show a native modal dialog summarizing the command, args, env keys (values
 * are shown redacted — a long API key would mask the diff). Returns true only
 * when the user explicitly clicks "Add".
 */
export async function confirmMcpAdd(
  req: McpAddRequest,
  { dialog, parentWindow }: ConfirmOptions
): Promise<boolean> {
  if (req.transport !== 'stdio') return true;

  const envKeys = req.env ? Object.keys(req.env).sort() : [];
  const detail = [
    `Name: ${req.name}`,
    `Command: ${req.command ?? '(none)'}`,
    `Args: ${(req.args ?? []).join(' ') || '(none)'}`,
    `Env keys: ${envKeys.join(', ') || '(none)'}`,
  ].join('\n');

  const res = await dialog.showMessageBox(parentWindow ?? undefined!, {
    type: 'warning',
    buttons: ['Cancel', 'Add MCP server'],
    defaultId: 0,
    cancelId: 0,
    title: 'Confirm MCP server',
    message: `Add MCP server "${req.name}"?`,
    detail:
      detail +
      '\n\nThis will spawn a local process with the above command on every project load. Only confirm if you trust this source.',
  });
  return res.response === 1;
}

export interface AuditEntry {
  ts: string;
  kind: 'mcp_add';
  decision: 'accepted' | 'rejected';
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  reason?: string;
}

/**
 * Append one JSONL audit entry. Failures are swallowed (logged to console) —
 * losing an audit line must never prevent the security decision from landing.
 */
export async function appendMcpAudit(
  logPath: string,
  entry: AuditEntry
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.warn('[mcp-add-guard] failed to write audit entry:', err);
  }
}
