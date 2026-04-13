/**
 * Workspace layout + version detection (fusion step 0.3).
 *
 * v1 (pre-fusion, shipped): flat `.cliodeck/*` with `hnsw.index`,
 *   `vectors.db`, `primary-sources.db`, `history.db`, `similarity_cache.json`,
 *   `<bibliography>.json`. No version marker.
 * v2 (post-fusion): `.cliodeck/v2/*` with `brain.db`, `hnsw.index`,
 *   `config.json` (schema_version:2), `hints.md`, `mcp-access.jsonl`,
 *   `security-events.jsonl`, `recipes/`, `recipes-runs/`.
 *
 * v1 and v2 coexist: migration copies/upgrades rather than overwriting, so
 * a workspace can be opened by both the pre- and post-fusion app during the
 * transition without data loss.
 */

import path from 'path';
import fs from 'fs/promises';

export const CLIODECK_DIR = '.cliodeck';
export const V2_SUBDIR = 'v2';
export const CLIOBRAIN_DIR = '.cliobrain';

export type WorkspaceVersion = 'none' | 'v1' | 'v2' | 'cliobrain';

export interface WorkspacePaths {
  root: string;
  /** `.cliodeck/` — present for v1 and v2 */
  cliodeckDir: string;
  /** `.cliodeck/v2/` — present only for v2 */
  v2Dir: string;
  /** `.cliobrain/` — present when migrating from ClioBrain */
  cliobrainDir: string;
}

export function workspacePaths(root: string): WorkspacePaths {
  return {
    root,
    cliodeckDir: path.join(root, CLIODECK_DIR),
    v2Dir: path.join(root, CLIODECK_DIR, V2_SUBDIR),
    cliobrainDir: path.join(root, CLIOBRAIN_DIR),
  };
}

export interface V2Paths {
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

export function v2Paths(workspaceRoot: string): V2Paths {
  const root = path.join(workspaceRoot, CLIODECK_DIR, V2_SUBDIR);
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
 * Detect the version of a workspace directory. A directory can legitimately
 * host multiple markers during migration (v1 present AND v2 being populated);
 * detection reports the *highest* upgradeable state so the UI can show
 * "already migrated" vs "migration available".
 */
export async function detectWorkspaceVersion(
  root: string
): Promise<WorkspaceVersion> {
  const p = workspacePaths(root);
  if (await exists(path.join(p.v2Dir, 'config.json'))) return 'v2';
  if (await exists(p.cliodeckDir)) return 'v1';
  if (await exists(p.cliobrainDir)) return 'cliobrain';
  return 'none';
}

export async function ensureV2Directories(workspaceRoot: string): Promise<V2Paths> {
  const p = v2Paths(workspaceRoot);
  await fs.mkdir(p.root, { recursive: true });
  await fs.mkdir(p.recipesDir, { recursive: true });
  await fs.mkdir(p.recipesRunsDir, { recursive: true });
  return p;
}
