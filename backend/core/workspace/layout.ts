/**
 * Workspace layout + version detection.
 *
 * Post-flatten layout: `.cliodeck/*` (flat) with `config.json`
 * (schema_version:2), `brain.db`, `hnsw.index`, `hints.md`, `mcp-access.jsonl`,
 * `security-events.jsonl`, `recipes/`, `recipes-runs/`, plus the SQLite stores
 * `vectors.db`, `primary-sources.db`, `history.db`, `obsidian-vectors.db` and
 * the renderer-owned `ideas.json`.
 *
 * Two legacy layouts are still recognized for auto-migration on workspace open:
 * - `legacy-subdir`: an in-flight `.cliodeck/v2/*` directory left over from the
 *   pre-flatten fusion branch. Migration moves every entry up one level.
 * - `legacy-flat`: pre-fusion v1 — `.cliodeck/` with no `config.json` anywhere.
 *   Migration writes a default `config.json`; every other file is already at
 *   its target path.
 */

import path from 'path';
import fs from 'fs/promises';

export const CLIODECK_DIR = '.cliodeck';
export const CLIOBRAIN_DIR = '.cliobrain';
/** Pre-flatten subdir, kept here only so the migrator can recognize and unwind it. */
export const LEGACY_V2_SUBDIR = 'v2';

export type WorkspaceVersion =
  | 'none'
  | 'flat'
  | 'legacy-subdir'
  | 'legacy-flat'
  | 'cliobrain';

export interface WorkspacePaths {
  root: string;
  cliodeckDir: string;
  cliobrainDir: string;
  /** Only meaningful when version === 'legacy-subdir'; emptied during migration. */
  legacyV2Dir: string;
}

export function workspacePaths(root: string): WorkspacePaths {
  return {
    root,
    cliodeckDir: path.join(root, CLIODECK_DIR),
    cliobrainDir: path.join(root, CLIOBRAIN_DIR),
    legacyV2Dir: path.join(root, CLIODECK_DIR, LEGACY_V2_SUBDIR),
  };
}

export interface WorkspaceFiles {
  root: string;
  config: string;
  brainDb: string;
  hnswIndex: string;
  hints: string;
  mcpAccessLog: string;
  securityEventsLog: string;
  recipesDir: string;
  recipesRunsDir: string;
}

export function workspaceFiles(workspaceRoot: string): WorkspaceFiles {
  const root = path.join(workspaceRoot, CLIODECK_DIR);
  return {
    root,
    config: path.join(root, 'config.json'),
    brainDb: path.join(root, 'brain.db'),
    hnswIndex: path.join(root, 'hnsw.index'),
    hints: path.join(root, 'hints.md'),
    mcpAccessLog: path.join(root, 'mcp-access.jsonl'),
    securityEventsLog: path.join(root, 'security-events.jsonl'),
    recipesDir: path.join(root, 'recipes'),
    recipesRunsDir: path.join(root, 'recipes-runs'),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the workspace state at `root`. Priority order: flat > legacy-subdir >
 * legacy-flat > cliobrain > none. A workspace can transiently host more than
 * one marker (e.g. legacy-subdir co-existing with a half-written flat config);
 * the highest-priority match wins and auto-migration handles the rest.
 */
export async function detectWorkspaceVersion(root: string): Promise<WorkspaceVersion> {
  const p = workspacePaths(root);
  if (await exists(path.join(p.cliodeckDir, 'config.json'))) return 'flat';
  if (await exists(path.join(p.legacyV2Dir, 'config.json'))) return 'legacy-subdir';
  if (await exists(p.cliodeckDir)) return 'legacy-flat';
  if (await exists(p.cliobrainDir)) return 'cliobrain';
  return 'none';
}

export async function ensureWorkspaceDirectories(
  workspaceRoot: string,
): Promise<WorkspaceFiles> {
  const p = workspaceFiles(workspaceRoot);
  await fs.mkdir(p.root, { recursive: true });
  await fs.mkdir(p.recipesDir, { recursive: true });
  await fs.mkdir(p.recipesRunsDir, { recursive: true });
  return p;
}
