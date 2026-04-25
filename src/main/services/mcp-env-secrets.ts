/**
 * MCP env-secret routing (fusion 1.5).
 *
 * MCP stdio clients are typically invoked with API keys passed via the
 * `env` field on `MCPClientConfig`. Until 1.5 those values landed
 * verbatim in `.cliodeck/v2/config.json` — i.e. on disk in plain text,
 * trivially readable by anyone with filesystem access. The audit log
 * already masked `env` values (see `backend/mcp-server/audit.ts`); this
 * module closes the same hole on the persisted config.
 *
 * Mechanism:
 *   - At `loadProject` time, scan every `mcpClients[].env` entry. Any
 *     value whose key looks like a secret (heuristic on the env name,
 *     matching `KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL` segments)
 *     and is not already a sentinel is moved into `secureStorage` under
 *     a stable per-client key. The on-disk config is rewritten with a
 *     `SECRET_SENTINEL` placeholder.
 *   - When a client is registered with the SDK manager, sentinels are
 *     resolved back to real values via `secureStorage.getKey`.
 *   - On `removeClient`, the corresponding secret is deleted to avoid
 *     orphans accumulating in the secret store.
 *
 * Non-goals:
 *   - This is not a full vault. Values are encrypted at rest by
 *     `safeStorage` (Electron) when an OS keyring is available; we
 *     inherit `secureStorage`'s plaintext fallback warning otherwise.
 *   - Non-sensitive env vars (`NODE_ENV`, `PATH`, …) stay in
 *     `config.json` so debugging the workspace doesn't require
 *     decrypting anything.
 */

import type { MCPClientConfig as WorkspaceClientConfig } from '../../../backend/core/workspace/config.js';
import { secureStorage } from './secure-storage.js';

/** Marker value written into `config.json` in place of a real secret.
 *  No real env var is ever expected to equal this string, so resolve()
 *  can detect the placeholder unambiguously. */
export const SECRET_SENTINEL = '__cliodeck_secret__';

/** Heuristic: does this env-var name look like it carries a secret? */
const SECRET_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)/i;

export function isSensitiveEnvVarName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/** Stable storage key for a given client/env pair. */
export function secretKeyFor(clientName: string, envKey: string): string {
  return `mcp.client.${clientName}.env.${envKey}`;
}

/**
 * Mutates `client` in place: every sensitive env value that is not yet
 * a sentinel is moved to `secureStorage` and replaced by `SECRET_SENTINEL`.
 * Returns true iff any value was migrated (callers persist the config
 * only when migrations actually happened).
 */
export function migrateClientEnvSecrets(client: WorkspaceClientConfig): boolean {
  if (!client.env) return false;
  let migrated = false;
  for (const [envKey, value] of Object.entries(client.env)) {
    if (typeof value !== 'string') continue;
    if (value === SECRET_SENTINEL) continue;
    if (!isSensitiveEnvVarName(envKey)) continue;
    secureStorage.setKey(secretKeyFor(client.name, envKey), value);
    client.env[envKey] = SECRET_SENTINEL;
    migrated = true;
  }
  return migrated;
}

/**
 * Returns a copy of `env` with all sentinels resolved against
 * `secureStorage`. Missing secrets are dropped (rather than passed as
 * empty strings) so a misconfigured client fails loudly inside the
 * MCP server rather than running with a blank credential.
 */
export function resolveClientEnvSecrets(
  clientName: string,
  env: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!env) return env;
  const out: Record<string, string> = {};
  for (const [envKey, value] of Object.entries(env)) {
    if (value === SECRET_SENTINEL) {
      const resolved = secureStorage.getKey(secretKeyFor(clientName, envKey));
      if (resolved) out[envKey] = resolved;
      // else: drop — the MCP server should error rather than silently
      // run unauthenticated against a third-party API.
      continue;
    }
    out[envKey] = value;
  }
  return out;
}

/**
 * Delete every secret associated with a client. Called from
 * `removeClient` so the secret store doesn't accumulate dead entries
 * once the user removes an MCP integration.
 */
export function deleteClientEnvSecrets(client: WorkspaceClientConfig): void {
  if (!client.env) return;
  for (const envKey of Object.keys(client.env)) {
    if (!isSensitiveEnvVarName(envKey)) continue;
    secureStorage.deleteKey(secretKeyFor(client.name, envKey));
  }
}
