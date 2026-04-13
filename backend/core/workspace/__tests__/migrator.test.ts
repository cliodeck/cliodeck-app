import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  detectWorkspaceVersion,
  v2Paths,
  CLIODECK_DIR,
  V2_SUBDIR,
  CLIOBRAIN_DIR,
} from '../layout.js';
import {
  migrateFromCliobrain,
  migrateFromCliodeckV1,
} from '../migrator.js';
import { readWorkspaceConfig } from '../config.js';

let tmpRoot = '';

async function makeTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-ws-'));
}

async function write(p: string, content = 'x'): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
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

  it('v1 when only .cliodeck/ exists', async () => {
    await write(path.join(tmpRoot, CLIODECK_DIR, 'hnsw.index'));
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('v1');
  });

  it('v2 when v2/config.json exists', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, V2_SUBDIR, 'config.json'),
      '{"schema_version":2}'
    );
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('v2');
  });

  it('cliobrain when only .cliobrain/ exists', async () => {
    await write(path.join(tmpRoot, CLIOBRAIN_DIR, 'brain.db'));
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('cliobrain');
  });
});

describe('migrateFromCliodeckV1', () => {
  it('is a no-op on empty workspace', async () => {
    const r = await migrateFromCliodeckV1(tmpRoot);
    expect(r.noop).toBeDefined();
    expect(r.copied).toHaveLength(0);
  });

  it('copies hnsw.index and writes a fresh v2 config', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, 'hnsw.index'),
      'INDEXBYTES'
    );
    const r = await migrateFromCliodeckV1(tmpRoot, { name: 'my-corpus' });
    expect(r.noop).toBeUndefined();
    expect(r.copied.some((c) => c.target.endsWith('hnsw.index'))).toBe(true);

    const cfg = await readWorkspaceConfig(tmpRoot);
    expect(cfg.schema_version).toBe(2);
    expect(cfg.name).toBe('my-corpus');
    expect(await detectWorkspaceVersion(tmpRoot)).toBe('v2');
  });

  it('leaves v1 data in place (additive migration)', async () => {
    const v1Hnsw = path.join(tmpRoot, CLIODECK_DIR, 'hnsw.index');
    await write(v1Hnsw, 'ORIGINAL');
    await migrateFromCliodeckV1(tmpRoot);
    const stillThere = await fs.readFile(v1Hnsw, 'utf8');
    expect(stillThere).toBe('ORIGINAL');
  });

  it('skips when v2 already exists, overwrite:true forces re-run', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, V2_SUBDIR, 'config.json'),
      JSON.stringify({ schema_version: 2, name: 'keep-me' })
    );
    await write(path.join(tmpRoot, CLIODECK_DIR, 'hnsw.index'), 'NEW');

    const r1 = await migrateFromCliodeckV1(tmpRoot);
    expect(r1.noop).toMatch(/already at v2/);

    const r2 = await migrateFromCliodeckV1(tmpRoot, { overwrite: true });
    expect(r2.noop).toBeUndefined();
    const copiedIdx = await fs.readFile(
      v2Paths(tmpRoot).hnswIndex,
      'utf8'
    );
    expect(copiedIdx).toBe('NEW');
  });

  it('reports empty sources as skipped with reason', async () => {
    await write(path.join(tmpRoot, CLIODECK_DIR, 'hnsw.index'), '');
    const r = await migrateFromCliodeckV1(tmpRoot);
    expect(
      r.skipped.find((s) => s.target.endsWith('hnsw.index'))?.reason
    ).toBe('empty_source');
  });
});

describe('migrateFromCliobrain', () => {
  it('is a no-op when .cliobrain is absent', async () => {
    const r = await migrateFromCliobrain(tmpRoot);
    expect(r.noop).toBeDefined();
  });

  it('copies canonical artifacts and merges config', async () => {
    const cb = path.join(tmpRoot, CLIOBRAIN_DIR);
    await write(path.join(cb, 'brain.db'), 'SQLITE');
    await write(path.join(cb, 'hnsw.index'), 'VEC');
    await write(path.join(cb, 'hints.md'), '# hints');
    await write(
      path.join(cb, 'config.json'),
      JSON.stringify({
        name: 'thesis',
        custom_field: 'preserved',
      })
    );

    const r = await migrateFromCliobrain(tmpRoot);
    expect(r.copied.map((c) => path.basename(c.target)).sort()).toEqual(
      ['brain.db', 'config.json', 'hints.md', 'hnsw.index']
    );

    const v2 = v2Paths(tmpRoot);
    expect(await fs.readFile(v2.brainDb, 'utf8')).toBe('SQLITE');

    const cfg = await readWorkspaceConfig(tmpRoot);
    expect(cfg.schema_version).toBe(2);
    expect(cfg.name).toBe('thesis');
    expect((cfg as Record<string, unknown>).custom_field).toBe('preserved');
  });

  it('mixed workspace: v1 + cliobrain side-by-side both migratable', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, 'hnsw.index'),
      'V1-INDEX'
    );
    await write(
      path.join(tmpRoot, CLIOBRAIN_DIR, 'brain.db'),
      'CB-DB'
    );

    // v1 wins detection — run v1 migrator first, then cliobrain on top.
    const r1 = await migrateFromCliodeckV1(tmpRoot);
    expect(r1.copied.some((c) => c.target.endsWith('hnsw.index'))).toBe(
      true
    );

    // Now v2 exists; cliobrain can still add brain.db without overwrite.
    const cfgBefore = await readWorkspaceConfig(tmpRoot);
    const r2 = await migrateFromCliobrain(tmpRoot);
    expect(r2.copied.some((c) => c.target.endsWith('brain.db'))).toBe(
      true
    );
    // No ClioBrain config.json present, so the v1-written v2 config stays
    // (no entry in copied or skipped for config.json).
    const cfgAfter = await readWorkspaceConfig(tmpRoot);
    expect(cfgAfter.created_at).toBe(cfgBefore.created_at);
    expect(cfgAfter.name).toBe(cfgBefore.name);
  });

  it('warns on malformed ClioBrain config', async () => {
    await write(
      path.join(tmpRoot, CLIOBRAIN_DIR, 'config.json'),
      '{not json'
    );
    const r = await migrateFromCliobrain(tmpRoot);
    expect(r.warnings.some((w) => w.includes('Failed to parse'))).toBe(
      true
    );
  });
});

describe('readWorkspaceConfig', () => {
  it('rejects newer schema_version', async () => {
    await write(
      path.join(tmpRoot, CLIODECK_DIR, V2_SUBDIR, 'config.json'),
      JSON.stringify({ schema_version: 99 })
    );
    await expect(readWorkspaceConfig(tmpRoot)).rejects.toThrow(
      /Unsupported workspace schema_version/
    );
  });
});
