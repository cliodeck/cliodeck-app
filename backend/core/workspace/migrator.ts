/**
 * Workspace migrator — produces the flat `.cliodeck/*` layout.
 *
 * Three migration entry points dispatched by `detectWorkspaceVersion`:
 *
 * - `legacy-subdir`: a `.cliodeck/v2/*` directory left over from the pre-flatten
 *   fusion branch. Move every entry up one level. Collisions resolve in favor
 *   of the existing flat file (the live writers — `HNSWVectorStore`, etc. —
 *   only ever wrote to flat; v2 copies were migration debris).
 *
 * - `legacy-flat`: pre-fusion v1. `.cliodeck/` exists with the old SQLite
 *   stores and `hnsw.index`, but no `config.json` anywhere. Migration writes
 *   a default `config.json`; everything else is already at the right path.
 *
 * - `cliobrain`: a bare `.cliobrain/` workspace. Copy canonical artifacts
 *   into the flat layout and merge any `.cliobrain/config.json` into the
 *   new `config.json` (unknown keys preserved).
 *
 * Partial-success report (claw-code lesson 6.3): `copied`, `skipped` with
 * typed reason, `warnings`. Never throws on a single missing file.
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
  ensureWorkspaceDirectories,
  workspaceFiles,
  workspacePaths,
  type WorkspaceFiles,
} from './layout.js';

export type SkipReason =
  | 'source_missing'
  | 'target_exists'
  | 'flat_already_present'
  | 'not_a_file'
  | 'empty_source';

export interface MigrationEntry {
  source: string;
  target: string;
}

export interface SkippedEntry extends MigrationEntry {
  reason: SkipReason;
}

export type MigrationKind = 'legacy-subdir' | 'legacy-flat' | 'cliobrain' | 'none';

export interface MigrationReport {
  kind: MigrationKind;
  workspaceRoot: string;
  copied: MigrationEntry[];
  skipped: SkippedEntry[];
  warnings: string[];
  /** Reason the whole migration was a no-op, when applicable. */
  noop?: string;
}

export interface MigrateOptions {
  /** Overwrite existing flat artifacts. Default false — safe by default. */
  overwrite?: boolean;
  /** Override the workspace name written into the new config. */
  name?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function safeStat(p: string): Promise<{ size: number; isFile: boolean } | null> {
  try {
    const s = await fs.stat(p);
    return { size: s.size, isFile: s.isFile() };
  } catch {
    return null;
  }
}

async function copyIfPresent(
  source: string,
  target: string,
  overwrite: boolean,
  report: MigrationReport,
): Promise<void> {
  const stat = await safeStat(source);
  if (!stat) {
    report.skipped.push({ source, target, reason: 'source_missing' });
    return;
  }
  if (!stat.isFile) {
    report.skipped.push({ source, target, reason: 'not_a_file' });
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

function makeReport(kind: MigrationKind, root: string, noop?: string): MigrationReport {
  return { kind, workspaceRoot: root, copied: [], skipped: [], warnings: [], noop };
}

/**
 * Bring the workspace at `root` to flat layout if needed. Idempotent: a
 * workspace already flat returns a no-op report.
 */
export async function migrateWorkspaceToFlat(
  workspaceRoot: string,
  opts: MigrateOptions = {},
): Promise<MigrationReport> {
  const version = await detectWorkspaceVersion(workspaceRoot);
  switch (version) {
    case 'none':
      return makeReport('none', workspaceRoot, 'No workspace artifacts found at root.');
    case 'flat':
      if (!opts.overwrite) {
        return makeReport('none', workspaceRoot, 'Workspace already at flat layout.');
      }
      // overwrite:true on a flat workspace = re-run legacy-flat (rewrites config).
      return migrateLegacyFlat(workspaceRoot, opts);
    case 'legacy-subdir':
      return migrateLegacySubdir(workspaceRoot, opts);
    case 'legacy-flat':
      return migrateLegacyFlat(workspaceRoot, opts);
    case 'cliobrain':
      return migrateCliobrain(workspaceRoot, opts);
  }
}

/**
 * Move every entry in `.cliodeck/v2/` up to `.cliodeck/`. Per-file rename for
 * atomicity; fall back to copy+unlink on EXDEV. On name collisions the flat
 * file wins (`flat_already_present` skip reason) unless `overwrite` is set.
 */
async function migrateLegacySubdir(
  root: string,
  opts: MigrateOptions,
): Promise<MigrationReport> {
  const report = makeReport('legacy-subdir', root);
  const paths = workspacePaths(root);
  const flat = await ensureWorkspaceDirectories(root);

  const entries = await fs.readdir(paths.legacyV2Dir, { withFileTypes: true });
  for (const e of entries) {
    const source = path.join(paths.legacyV2Dir, e.name);
    const target = path.join(flat.root, e.name);
    if (e.isDirectory()) {
      await mergeDir(source, target, opts.overwrite ?? false, report);
      await fs.rmdir(source).catch(() => {
        /* dir may be non-empty after collisions — leave it for the caller to see */
      });
    } else {
      await moveFile(source, target, opts.overwrite ?? false, report);
    }
  }

  try {
    await fs.rmdir(paths.legacyV2Dir);
  } catch (e) {
    report.warnings.push(
      `legacy .cliodeck/v2/ not removed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!(await exists(flat.config))) {
    // The v2 subdir lacked a config.json — write a default so the workspace is openable.
    await writeWorkspaceConfig(root, defaultWorkspaceConfig(opts.name ?? path.basename(root)));
    report.copied.push({ source: '(generated)', target: flat.config });
  }

  return report;
}

async function moveFile(
  source: string,
  target: string,
  overwrite: boolean,
  report: MigrationReport,
): Promise<void> {
  if (!overwrite && (await exists(target))) {
    report.skipped.push({ source, target, reason: 'flat_already_present' });
    return;
  }
  try {
    await fs.rename(source, target);
    report.copied.push({ source, target });
  } catch (err) {
    // EXDEV (cross-device) or similar — fall back to copy+unlink.
    await fs.copyFile(source, target);
    await fs.unlink(source);
    report.copied.push({ source, target });
    report.warnings.push(
      `rename fell back to copy for ${source}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function mergeDir(
  source: string,
  target: string,
  overwrite: boolean,
  report: MigrationReport,
): Promise<void> {
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(source, e.name);
    const t = path.join(target, e.name);
    if (e.isDirectory()) {
      await mergeDir(s, t, overwrite, report);
      await fs.rmdir(s).catch(() => {});
    } else {
      await moveFile(s, t, overwrite, report);
    }
  }
}

/** Pre-fusion v1 workspace: ensure a flat `config.json` exists. */
async function migrateLegacyFlat(
  root: string,
  opts: MigrateOptions,
): Promise<MigrationReport> {
  const report = makeReport('legacy-flat', root);
  const flat = await ensureWorkspaceDirectories(root);

  if (!(await exists(flat.config)) || opts.overwrite) {
    await writeWorkspaceConfig(
      root,
      defaultWorkspaceConfig(opts.name ?? path.basename(root)),
    );
    report.copied.push({ source: '(generated)', target: flat.config });
  } else {
    report.skipped.push({
      source: '(generated)',
      target: flat.config,
      reason: 'target_exists',
    });
  }

  return report;
}

/**
 * File-match list for ClioBrain → flat. Extend when a real ClioBrain workspace
 * is observed; the paths below are the plausible canonical ones per the fusion
 * strategy doc.
 */
const CLIOBRAIN_MATCHES: Array<{ source: string; target: keyof WorkspaceFiles }> = [
  { source: 'brain.db', target: 'brainDb' },
  { source: 'hnsw.index', target: 'hnswIndex' },
  { source: 'hints.md', target: 'hints' },
  { source: 'mcp-access.jsonl', target: 'mcpAccessLog' },
];

async function migrateCliobrain(
  root: string,
  opts: MigrateOptions,
): Promise<MigrationReport> {
  const report = makeReport('cliobrain', root);
  const paths = workspacePaths(root);
  const flat = await ensureWorkspaceDirectories(root);

  for (const m of CLIOBRAIN_MATCHES) {
    const source = path.join(paths.cliobrainDir, m.source);
    const target = flat[m.target] as string;
    await copyIfPresent(source, target, opts.overwrite ?? false, report);
  }

  // Merge ClioBrain config.json into the flat config (preserving unknown keys).
  const cliobrainCfg = path.join(paths.cliobrainDir, 'config.json');
  if (await exists(cliobrainCfg)) {
    try {
      const raw = await fs.readFile(cliobrainCfg, 'utf8');
      const legacy = JSON.parse(raw) as Record<string, unknown>;
      const merged: WorkspaceConfig = {
        ...defaultWorkspaceConfig(opts.name ?? path.basename(root)),
        ...legacy,
        schema_version: 2,
      };
      if (!(await exists(flat.config)) || opts.overwrite) {
        await writeWorkspaceConfig(root, merged);
        report.copied.push({ source: cliobrainCfg, target: flat.config });
      } else {
        report.skipped.push({
          source: cliobrainCfg,
          target: flat.config,
          reason: 'target_exists',
        });
      }
    } catch (e) {
      report.warnings.push(
        `Failed to parse ClioBrain config.json: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else if (!(await exists(flat.config))) {
    await writeWorkspaceConfig(
      root,
      defaultWorkspaceConfig(opts.name ?? path.basename(root)),
    );
    report.copied.push({ source: '(generated)', target: flat.config });
  }

  if (report.copied.length === 0) {
    report.warnings.push(
      'ClioBrain → flat migration ran but copied nothing; .cliobrain looks empty or uses an unrecognized layout.',
    );
  }
  return report;
}
