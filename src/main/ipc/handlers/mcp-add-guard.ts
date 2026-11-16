/**
 * Security guard for `fusion:mcp:add` (see RCE mitigation task).
 *
 * The IPC handler accepts a stdio command + args + env from the renderer and
 * spawns it via `StdioClientTransport`. A compromised renderer (XSS, malicious
 * dep, RAG-injected content) could therefore achieve RCE. This module provides
 * the three pre-spawn checks:
 *
 *   1. Whitelist the `command` (known interpreters or validated absolute paths),
 *      or, for SSE, accept only an http(s) URL.
 *   2. Sanitize the `env` map (key shape + no control chars in values).
 *   3. Require a native confirmation dialog from the user in the main process,
 *      for SSE too: the arguments of tool calls are sent to its URL.
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
import { t } from '../../i18n.js';
import { isSensitiveEnvVarName } from '../../services/mcp-env-secrets.js';

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
 * Validate the command + env of an incoming stdio MCP add request. An SSE
 * request spawns nothing: only its URL is checked, which must be http(s)
 * (S09-2-3: `file://` or `javascript:` is not the address of a server).
 */
export function validateMcpAddRequest(req: McpAddRequest): McpAddValidation {
  if (req.transport !== 'stdio') {
    return isHttpUrl(req.url) ? { ok: true } : { ok: false, reason: 'sse_url_invalid' };
  }

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

function isHttpUrl(url: string | undefined): boolean {
  if (!url || CONTROL_CHARS_RE.test(url)) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Env keys that decide which program actually runs, or where it is downloaded from: `PATH` picks
 * the `npx` that is executed, the others the registry `npx`, `pip` or `uvx` fetch the package
 * from (S09-1-22). `HOME`, `XDG_*`, `APPDATA`, `LOCALAPPDATA` and `USERPROFILE` do it through the
 * configuration files they point to (`~/.npmrc`, `pip.conf`, `uv.toml`, Python's user
 * site-packages). The dialog names them in a warning.
 */
export function redirectsCommand(key: string): boolean {
  return (
    ['PATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE'].includes(key) ||
    /^(NPM_CONFIG_|PIP_|UV_|XDG_)/.test(key) ||
    /(_REGISTRY|_INDEX_URL)$/.test(key)
  );
}

export interface ConfirmOptions {
  dialog: Pick<Dialog, 'showMessageBox'>;
  parentWindow?: Electron.BrowserWindow | null;
}

/**
 * The lines of the dialog that describe a stdio server: command, args, env. Every env value is
 * shown, except those of the keys that look like secrets: a value hidden from the author cannot be
 * judged, and the author cannot spot a redirection by its name alone.
 */
function stdioDetail(req: McpAddRequest): string[] {
  const env = Object.entries(req.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const shown = (key: string): boolean => !isSensitiveEnvVarName(key);
  // Only the keys whose value is shown: the warning asks the author to check it.
  const redirects = env.map(([key]) => key).filter((key) => shown(key) && redirectsCommand(key));
  const args = (req.args ?? []).join(' ');
  return [
    t('mcpConfirmCommand').replace('{{command}}', () => req.command ?? ''),
    args ? t('mcpConfirmArgs').replace('{{args}}', () => args) : t('mcpConfirmArgsNone'),
    env.length > 0
      ? t('mcpConfirmEnv').replace('{{env}}', () =>
          env.map(([key, value]) => (shown(key) ? `${key}=${value}` : key)).join(', ')
        )
      : t('mcpConfirmEnvNone'),
    ...(redirects.length > 0
      ? ['', t('mcpConfirmEnvRedirect').replace('{{keys}}', () => redirects.join(', '))]
      : []),
    '',
    t('mcpConfirmStdioWarning'),
  ];
}

/**
 * Show a native modal dialog describing the server: the command, args and env of a stdio server
 * (secret values hidden), or the URL of an SSE server and what is sent to it. Returns true only
 * when the user explicitly clicks "Add".
 */
export async function confirmMcpAdd(
  req: McpAddRequest,
  { dialog, parentWindow }: ConfirmOptions
): Promise<boolean> {
  const detail = [
    t('mcpConfirmName').replace('{{name}}', () => req.name),
    ...(req.transport === 'stdio'
      ? stdioDetail(req)
      : [t('mcpConfirmUrl').replace('{{url}}', () => req.url ?? ''), '', t('mcpConfirmSseWarning')]),
  ].join('\n');

  const res = await dialog.showMessageBox(parentWindow ?? undefined!, {
    type: 'warning',
    buttons: [t('mcpConfirmCancel'), t('mcpConfirmAccept')],
    defaultId: 0,
    cancelId: 0,
    title: t('mcpConfirmTitle'),
    message: t('mcpConfirmMessage').replace('{{name}}', () => req.name),
    detail,
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
