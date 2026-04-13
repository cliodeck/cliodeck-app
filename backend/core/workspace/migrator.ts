/**
 * Workspace migrator (fusion step 0.3).
 *
 * Migrations are **additive**: v1 data under `.cliodeck/*` is preserved
 * untouched, v2 artifacts are written under `.cliodeck/v2/*`. A ClioBrain
 * source migration reads `.cliobrain/*` and populates `.cliodeck/v2/*`.
 *
 * Migrations return a **partial-success report** (claw-code lesson 6.3):
 * `copied[]`, `skipped[]` with typed reason, `warnings[]`. Never throws on a
 * single missing file — the caller gets a full picture and decides what to
 * do. Hard failure is reserved for filesystem errors that block the whole
 * operation.
 *
 * Scope of this first cut:
 * - v1 → v2: copy `hnsw.index` if present; leave SQLite dbs in place (they
 *   stay reachable through the v1 path until a feature-level migration
 *   moves each store into `brain.db`).
 * - ClioBrain → v2: copy canonical artifacts when they exist
 *   (`config.json`, `brain.db`, `hnsw.index`, `hints.md`). Assumes a
 *   reasonable ClioBrain layout; extend the fixture match list when a real
 *   ClioBrain workspace arrives.
 */

import fs from 'fs/promises';
import path from 'path';
import {
  defaultWorkspaceConfig,
  writeWorkspaceConfig,
  type WorkspaceConfig,
} from './config.js';
import {
  detectWorkspaceVersion,
  ensureV2Directories,
  v2Paths,
  workspacePaths,
} from './layout.js';

export type SkipReason =
  | 'source_missing'
  | 'target_exists'
  | 'not_a_file'
  | 'empty_source';

export interface MigrationEntry {
  source: string;
  target: string;
}

export interface SkippedEntry extends MigrationEntry {
  reason: SkipReason;
}

export interface MigrationReport {
  kind: 'cliodeck-v1' | 'cliobrain';
  workspaceRoot: string;
  copied: MigrationEntry[];
  skipped: SkippedEntry[];
  warnings: string[];
  /** Reason the whole migration was a no-op, when applicable. */
  noop?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function safeStat(p: string): Promise<{ size: number } | null> {
  try {
    const s = await fs.stat(p);
    return { size: s.size };
  } catch {
    return null;
  }
}

async function copyIfPresent(
  source: string,
  target: string,
  overwrite: boolean,
  report: MigrationReport
): Promise<void> {
  const stat = await safeStat(source);
  if (!stat) {
    report.skipped.push({ source, target, reason: 'source_missing' });
    return;
  }
  if (stat.size === 0) {
    report.skipped.push({ source, target, reason: 'empty_source' });
    return;
  }
  if (!overwrite && (await exists(target))) {
    report.skipped.push({ source, target, reason: 'target_exists' });
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
  report.copied.push({ source, target });
}

export interface MigrateOptions {
  /** Overwrite existing v2 artifacts. Default false — safe by default. */
  overwrite?: boolean;
  /** Override the workspace name written into the new config. */
  name?: string;
}

export async function migrateFromCliodeckV1(
  workspaceRoot: string,
  opts: MigrateOptions = {}
): Promise<MigrationReport> {
  const report: MigrationReport = {
    kind: 'cliodeck-v1',
    workspaceRoot,
    copied: [],
    skipped: [],
    warnings: [],
  };

  const version = await detectWorkspaceVersion(workspaceRoot);
  if (version === 'none') {
    report.noop = 'No .cliodeck directory found at workspace root.';
    return report;
  }
  if (version === 'v2' && !opts.overwrite) {
    report.noop = 'Workspace already at v2; pass overwrite:true to re-run.';
    return report;
  }

  const paths = workspacePaths(workspaceRoot);
  const v2 = await ensureV2Directories(workspaceRoot);

  // Preserve v1 SQLite databases in place — they remain addressable through
  // the legacy `.cliodeck/*` paths. Only portable artifacts get copied.
  await copyIfPresent(
    path.join(paths.cliodeckDir, 'hnsw.index'),
    v2.hnswIndex,
    opts.overwrite ?? false,
    report
  );

  // Write a fresh v2 config if none exists; don't clobber an existing one.
  if (!(await exists(v2.config)) || opts.overwrite) {
    const cfg: WorkspaceConfig = {
      ...defaultWorkspaceConfig(opts.name ?? path.basename(workspaceRoot)),
    };
    await writeWorkspaceConfig(workspaceRoot, cfg);
    report.copied.push({
      source: '(generated)',
      target: v2.config,
    });
  } else {
    report.skipped.push({
      source: '(generated)',
      target: v2.config,
      reason: 'target_exists',
    });
  }

  if (report.copied.length === 0 && !report.noop) {
    report.warnings.push(
      'v1 → v2 migration ran but copied nothing; v1 workspace may be empty or already fully migrated.'
    );
  }

  return report;
}

/**
 * File-match list for ClioBrain → v2. Tuples: [source-rel-path, v2-key].
 * Extend when a real ClioBrain workspace is observed — the source paths
 * below are the plausible canonical ones per the ClioBrain layout described
 * in the fusion strategy doc.
 */
const CLIOBRAIN_MATCHES: Array<{ source: string; target: keyof ReturnType<typeof v2Paths> }> = [
  { source: 'brain.db', target: 'brainDb' },
  { source: 'hnsw.index', target: 'hnswIndex' },
  { source: 'hints.md', target: 'hints' },
  { source: 'mcp-access.jsonl', target: 'mcpAccessLog' },
];

export async function migrateFromCliobrain(
  workspaceRoot: string,
  opts: MigrateOptions = {}
): Promise<MigrationReport> {
  const report: MigrationReport = {
    kind: 'cliobrain',
    workspaceRoot,
    copied: [],
    skipped: [],
    warnings: [],
  };

  const paths = workspacePaths(workspaceRoot);
  if (!(await exists(paths.cliobrainDir))) {
    report.noop = 'No .cliobrain directory found at workspace root.';
    return report;
  }

  const v2 = await ensureV2Directories(workspaceRoot);

  for (const m of CLIOBRAIN_MATCHES) {
    const source = path.join(paths.cliobrainDir, m.source);
    const target = v2[m.target] as string;
    await copyIfPresent(source, target, opts.overwrite ?? false, report);
  }

  // Merge ClioBrain config.json into the v2 config (preserving unknown keys).
  const cliobrainCfg = path.join(paths.cliobrainDir, 'config.json');
  if (await exists(cliobrainCfg)) {
    try {
      const raw = await fs.readFile(cliobrainCfg, 'utf8');
      const legacy = JSON.parse(raw) as Record<string, unknown>;
      const merged: WorkspaceConfig = {
        ...defaultWorkspaceConfig(opts.name ?? path.basename(workspaceRoot)),
        ...legacy,
        schema_version: 2,
      };
      if (!(await exists(v2.config)) || opts.overwrite) {
        await writeWorkspaceConfig(workspaceRoot, merged);
        report.copied.push({ source: cliobrainCfg, target: v2.config });
      } else {
        report.skipped.push({
          source: cliobrainCfg,
          target: v2.config,
          reason: 'target_exists',
        });
      }
    } catch (e) {
      report.warnings.push(
        `Failed to parse ClioBrain config.json: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  } else if (!(await exists(v2.config))) {
    // No ClioBrain config + no v2 config yet — write a fresh default so the
    // workspace is openable post-migration.
    await writeWorkspaceConfig(
      workspaceRoot,
      defaultWorkspaceConfig(opts.name ?? path.basename(workspaceRoot))
    );
    report.copied.push({ source: '(generated)', target: v2.config });
  }

  if (report.copied.length === 0) {
    report.warnings.push(
      'ClioBrain → v2 migration ran but copied nothing; the .cliobrain directory looks empty or uses an unrecognized layout.'
    );
  }

  return report;
}
