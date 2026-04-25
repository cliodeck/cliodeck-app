/**
 * Workspace v2 config schema (fusion step 0.3).
 *
 * `schema_version` is the canonical marker: any loader must refuse to operate
 * on a workspace whose `schema_version` is greater than its own compile-time
 * `WORKSPACE_SCHEMA_VERSION` (forward-compat is not implied). Unknown fields
 * are preserved on save so older clients don't silently strip new settings.
 */

import fs from 'fs/promises';
import { v2Paths } from './layout.js';

export const WORKSPACE_SCHEMA_VERSION = 2 as const;

export interface MCPClientConfig {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface WorkspaceConfig {
  schema_version: 2;
  /** Human-readable workspace name. */
  name?: string;
  /** ISO timestamps for audit trail. */
  created_at?: string;
  updated_at?: string;
  /** LLM provider config; consumed by ProviderRegistry (1.3). */
  llm?: {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKey?: string;
  };
  embedding?: {
    provider: string;
    model: string;
    dimension: number;
    baseUrl?: string;
    apiKey?: string;
  };
  /** External MCP servers the workspace can consume (phase 4.4). */
  mcpClients?: MCPClientConfig[];
  /** Source-inspector defence policy (phase 4.5). Optional — absent means
   * default `warn`. Stored per-workspace so the choice survives across
   * sessions and can vary by project (a corpus of public archives may
   * accept stricter `block`; one full of historical primary sources with
   * imperative speech may need `warn`). */
  security?: {
    sourceInspectorMode?: 'warn' | 'audit' | 'block';
  };
  /** Catch-all for forward-compat: unknown keys are preserved. */
  [k: string]: unknown;
}

export function defaultWorkspaceConfig(name?: string): WorkspaceConfig {
  const now = new Date().toISOString();
  return {
    schema_version: WORKSPACE_SCHEMA_VERSION,
    name,
    created_at: now,
    updated_at: now,
  };
}

export async function readWorkspaceConfig(
  workspaceRoot: string
): Promise<WorkspaceConfig> {
  const p = v2Paths(workspaceRoot);
  const raw = await fs.readFile(p.config, 'utf8');
  const parsed = JSON.parse(raw) as Partial<WorkspaceConfig>;
  if (parsed.schema_version !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported workspace schema_version: ${String(parsed.schema_version)} (expected ${WORKSPACE_SCHEMA_VERSION})`
    );
  }
  return parsed as WorkspaceConfig;
}

export async function writeWorkspaceConfig(
  workspaceRoot: string,
  cfg: WorkspaceConfig
): Promise<void> {
  const p = v2Paths(workspaceRoot);
  const toWrite: WorkspaceConfig = {
    ...cfg,
    schema_version: WORKSPACE_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
  };
  await fs.writeFile(p.config, JSON.stringify(toWrite, null, 2), 'utf8');
}
