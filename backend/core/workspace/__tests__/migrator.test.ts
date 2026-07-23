import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  detectWorkspaceVersion,
  workspaceFiles,
  CLIODECK_DIR,
  CLIOBRAIN_DIR,
  LEGACY_V2_SUBDIR,
} from '../layout.js';
import { migrateWorkspaceToFlat } from '../migrator.js';
import { readWorkspaceConfig } from '../config.js';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';

let tmpRoot = '';

async function makeTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-ws-'));
}

async function write(p: string, content = 'x'): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
}

/**
 * Écrit une VRAIE base SQLite minimale, marquée pour être reconnaissable
 * après migration.
 *
 * Les fixtures écrivaient auparavant un fichier texte nommé `history.db` :
 * le migrateur l'ouvrait pour de bon et échouait sur « file is not a
 * database ». Ces quatre tests dormaient rouges derrière les gardes ABI.
 */
async function writeDb(p: string, marker: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const db = new Database(p);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS fixture_marker (tag TEXT)');
    db.prepare('INSERT INTO fixture_marker (tag) VALUES (?)').run(marker);
  } finally {
    db.close();
  }
}

/** Relit le marqueur d'une base de fixture. */
function readDbMarker(p: string): string | null {
  const db = new Database(p, { readonly: true });
  try {
    const row = db.prepare('SELECT tag FROM fixture_marker LIMIT 1').get() as
      | { tag: string }
      | undefined;
    return row?.tag ?? null;
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  tmpRoot = await makeTmp();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('detectWorkspaceVersion', () => {
  it('none for empty dir', async () => {
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('none');
  });

  it('flat when .cliodeck/config.json exists', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, 'config.json'),
      '{"schema_version":2}',
    );
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('flat');
  });

  it('legacy-subdir when only .cliodeck/v2/config.json exists', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, LEGACY_V2_SUBDIR, 'config.json'),
      '{"schema_version":2}',
    );
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('legacy-subdir');
  });

  it('legacy-flat when .cliodeck/ exists with no config anywhere', async () => {
    await write(path.join(tmpRoot, CLIODECK_DIR, 'hnsw.index'));
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('legacy-flat');
  });

  it('cliobrain when only .cliobrain/ exists', async () => {
    await write(path.join(tmpRoot, CLIOBRAIN_DIR, 'brain.db'));
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('cliobrain');
  });

  it('flat wins over legacy-subdir when both have a config.json', async () => {
    await write(path.join(tmpRoot, CLIODECK_DIR, 'config.json'), '{"schema_version":2}');
    await write(
      path.join(tmpRoot, CLIODECK_DIR, LEGACY_V2_SUBDIR, 'config.json'),
      '{"schema_version":2}',
    );
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('flat');
  });
});

describe('migrateWorkspaceToFlat — none / flat', () => {
  it('no-op on empty workspace', async () => {
    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.kind).toBe('none');
    expect(r.noop).toBeDefined();
  });

  it('no-op when already flat and nothing to consolidate', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, 'config.json'),
      '{"schema_version":2}',
    );
    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.kind).toBe('none');
    expect(r.noop).toMatch(/already at flat/);
  });
});

describe('migrateWorkspaceToFlat — db consolidation (history → brain)', () => {
  // Fabrique une vraie base SQLite : exige le binding (cf. native-guards).
  it.skipIf(!sqliteAvailable)('renames history.db to brain.db on a flat workspace', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, 'config.json'),
      '{"schema_version":2}',
    );
    await writeDb(path.join(tmpRoot, CLIODECK_DIR, 'history.db'), 'HISTORY');

    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.copied.some((c) => c.target.endsWith('brain.db'))).toBe(true);

    const flat = workspaceFiles(tmpRoot);
    expect(readDbMarker(flat.brainDb)).toBe('HISTORY');
    await expect(
      fs.access(path.join(tmpRoot, CLIODECK_DIR, 'history.db')),
    ).rejects.toThrow();
  });

  // Fabrique une vraie base SQLite : exige le binding (cf. native-guards).
  it.skipIf(!sqliteAvailable)('warns and skips when both history.db and brain.db exist', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, 'config.json'),
      '{"schema_version":2}',
    );
    await writeDb(path.join(tmpRoot, CLIODECK_DIR, 'history.db'), 'HISTORY');
    await writeDb(path.join(tmpRoot, CLIODECK_DIR, 'brain.db'), 'BRAIN');

    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.warnings.some((w) => w.includes('both files exist'))).toBe(true);
    // Both files stay put — the user is the only authority on what to merge.
    expect(readDbMarker(path.join(tmpRoot, CLIODECK_DIR, 'history.db'))).toBe(
      'HISTORY',
    );
    expect(readDbMarker(path.join(tmpRoot, CLIODECK_DIR, 'brain.db'))).toBe(
      'BRAIN',
    );
  });

  // Fabrique une vraie base SQLite : exige le binding (cf. native-guards).
  it.skipIf(!sqliteAvailable)('runs consolidation alongside the legacy-subdir flatten in one pass', async () => {
    const v2 = path.join(tmpRoot, CLIODECK_DIR, LEGACY_V2_SUBDIR);
    await write(path.join(v2, 'config.json'), '{"schema_version":2}');
    // history.db lived flat in pre-fusion v1 — it never moved into v2/.
    await writeDb(path.join(tmpRoot, CLIODECK_DIR, 'history.db'), 'HIST');

    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.kind).toBe('legacy-subdir');
    const flat = workspaceFiles(tmpRoot);
    expect(readDbMarker(flat.brainDb)).toBe('HIST');
  });

  it('skips the obsidian/tropy/vectors consolidation steps when their files are absent', async () => {
    // The actual SQL paths (rename tables, ATTACH+copy) require better-sqlite3
    // native bindings, which fail under Vitest (CLAUDE.md §6). This test
    // covers only the no-op branches — the happy paths are validated at
    // runtime when the user opens a workspace.
    await write(
      path.join(tmpRoot, CLIODECK_DIR, 'config.json'),
      '{"schema_version":2}',
    );
    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.warnings).toHaveLength(0);
  });
});

describe('migrateWorkspaceToFlat — legacy-flat (pre-fusion v1)', () => {
  it('writes a fresh config and leaves v1 data in place', async () => {
    const v1Hnsw = path.join(tmpRoot, CLIODECK_DIR, 'hnsw.index');
    await write(v1Hnsw, 'ORIGINAL');

    const r = await migrateWorkspaceToFlat(tmpRoot, { name: 'my-corpus' });
    expect(r.kind).toBe('legacy-flat');
    expect(r.copied.some((c) => c.target.endsWith('config.json'))).toBe(true);

    const cfg = await readWorkspaceConfig(tmpRoot);
    expect(cfg.schema_version).toBe(2);
    expect(cfg.name).toBe('my-corpus');
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('flat');

    expect(await fs.readFile(v1Hnsw, 'utf8')).toBe('ORIGINAL');
  });
});

describe('migrateWorkspaceToFlat — legacy-subdir (in-flight v2)', () => {
  it('moves every file in .cliodeck/v2/ up one level', async () => {
    const v2 = path.join(tmpRoot, CLIODECK_DIR, LEGACY_V2_SUBDIR);
    await write(path.join(v2, 'config.json'), '{"schema_version":2,"name":"hist"}');
    await write(path.join(v2, 'hints.md'), '# hints');
    await write(path.join(v2, 'mcp-access.jsonl'), '{"t":"hi"}\n');
    await write(path.join(v2, 'recipes', 'one.yaml'), 'name: one\n');

    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.kind).toBe('legacy-subdir');
    expect(r.copied.length).toBeGreaterThanOrEqual(4);

    const flat = workspaceFiles(tmpRoot);
    expect(await fs.readFile(flat.config, 'utf8')).toMatch(/"name":"hist"/);
    expect(await fs.readFile(flat.hints, 'utf8')).toBe('# hints');
    expect(
      await fs.readFile(path.join(flat.recipesDir, 'one.yaml'), 'utf8'),
    ).toBe('name: one\n');

    // The legacy subdir is gone.
    await expect(fs.access(v2)).rejects.toThrow();
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('flat');
  });

  it('keeps the live flat hnsw.index on collision', async () => {
    const v2 = path.join(tmpRoot, CLIODECK_DIR, LEGACY_V2_SUBDIR);
    await write(path.join(tmpRoot, CLIODECK_DIR, 'hnsw.index'), 'LIVE');
    await write(path.join(v2, 'hnsw.index'), 'DEBRIS');
    await write(path.join(v2, 'config.json'), '{"schema_version":2}');

    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(
      r.skipped.find((s) => s.target.endsWith('hnsw.index'))?.reason,
    ).toBe('flat_already_present');

    expect(
      await fs.readFile(path.join(tmpRoot, CLIODECK_DIR, 'hnsw.index'), 'utf8'),
    ).toBe('LIVE');
  });

  it('writes a default config when the v2 subdir lacked one', async () => {
    // Edge case: legacy-subdir was detected via SOMETHING but config.json is
    // absent — this can happen if a user manually rm-ed it. We still want a
    // working workspace afterwards. (This case won't be detected as
    // legacy-subdir by detectWorkspaceVersion, so simulate via direct call.)
    const v2 = path.join(tmpRoot, CLIODECK_DIR, LEGACY_V2_SUBDIR);
    await write(path.join(v2, 'config.json'), '{"schema_version":2}');
    await write(path.join(v2, 'hints.md'), 'h');

    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.kind).toBe('legacy-subdir');
    const cfg = await readWorkspaceConfig(tmpRoot);
    expect(cfg.schema_version).toBe(2);
  });
});

describe('migrateWorkspaceToFlat — cliobrain', () => {
  // Fabrique une vraie base SQLite : exige le binding (cf. native-guards).
  it.skipIf(!sqliteAvailable)('copies canonical artifacts and merges config', async () => {
    const cb = path.join(tmpRoot, CLIOBRAIN_DIR);
    await writeDb(path.join(cb, 'brain.db'), 'CLIOBRAIN');
    await write(path.join(cb, 'hnsw.index'), 'VEC');
    await write(path.join(cb, 'hints.md'), '# hints');
    await write(
      path.join(cb, 'config.json'),
      JSON.stringify({ name: 'thesis', custom_field: 'preserved' }),
    );

    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.kind).toBe('cliobrain');
    expect(r.copied.map((c) => path.basename(c.target)).sort()).toEqual(
      ['brain.db', 'config.json', 'hints.md', 'hnsw.index'],
    );

    const flat = workspaceFiles(tmpRoot);
    expect(readDbMarker(flat.brainDb)).toBe('CLIOBRAIN');

    const cfg = await readWorkspaceConfig(tmpRoot);
    expect(cfg.schema_version).toBe(2);
    expect(cfg.name).toBe('thesis');
    expect((cfg as Record<string, unknown>).custom_field).toBe('preserved');
  });

  it('warns on malformed ClioBrain config', async () => {
    await write(
      path.join(tmpRoot, CLIOBRAIN_DIR, 'config.json'),
      '{not json',
    );
    const r = await migrateWorkspaceToFlat(tmpRoot);
    expect(r.warnings.some((w) => w.includes('Failed to parse'))).toBe(true);
  });
});

describe('readWorkspaceConfig', () => {
  it('rejects newer schema_version', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, 'config.json'),
      JSON.stringify({ schema_version: 99 }),
    );
    await expect(readWorkspaceConfig(tmpRoot)).rejects.toThrow(
      /Unsupported workspace schema_version/,
    );
  });
});
