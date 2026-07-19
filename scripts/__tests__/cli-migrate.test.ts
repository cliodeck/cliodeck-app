import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runCli } from '../cliodeck-cli.js';
import { sqliteAvailable } from '../../backend/__tests__/helpers/native-guards.js';

let tmp = '';
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-migrate-'));
  stdoutChunks = [];
  stderrChunks = [];
  stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      stdoutChunks.push(chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk));
      return true;
    });
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      stderrChunks.push(chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk));
      return true;
    });
});
afterEach(async () => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeFile(rel: string, content = 'x'): Promise<void> {
  const p = path.join(tmp, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
}

/**
 * Vraie base SQLite minimale — un fichier texte nommé `.db` faisait échouer
 * la migration pour de bon (« file is not a database »), échec masqué par
 * les gardes ABI.
 */
async function writeDb(rel: string, marker: string): Promise<void> {
  const p = path.join(tmp, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const db = new Database(p);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS fixture_marker (tag TEXT)');
    db.prepare('INSERT INTO fixture_marker (tag) VALUES (?)').run(marker);
  } finally {
    db.close();
  }
}

function readDbMarker(abs: string): string | null {
  const db = new Database(abs, { readonly: true });
  try {
    const row = db.prepare('SELECT tag FROM fixture_marker LIMIT 1').get() as
      | { tag: string }
      | undefined;
    return row?.tag ?? null;
  } finally {
    db.close();
  }
}

function stdout(): string {
  return stdoutChunks.join('');
}
function stderr(): string {
  return stderrChunks.join('');
}

describe('cliodeck import-cliobrain (5.2)', () => {
  it('returns usage error when workspace arg is missing', async () => {
    const code = await runCli(['import-cliobrain']);
    expect(code).toBe(2);
    expect(stderr()).toMatch(/import-cliobrain/);
  });

  // Fabrique une vraie base SQLite : exige le binding (cf. native-guards).
  it.skipIf(!sqliteAvailable)('migrates a minimal cliobrain workspace and prints a JSON report', async () => {
    await writeDb('.cliobrain/brain.db', 'SQLITE');
    await writeFile('.cliobrain/hnsw.index', 'VEC');
    await writeFile(
      '.cliobrain/config.json',
      JSON.stringify({ name: 'thesis', custom: 'kept' }),
    );

    const code = await runCli(['import-cliobrain', tmp]);
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout()) as {
      kind: string;
      copied: unknown[];
      skipped: unknown[];
      warnings: unknown[];
    };
    expect(parsed.kind).toBe('cliobrain');
    expect(parsed.copied.length).toBeGreaterThan(0);

    // The flat layout should now hold the copied files.
    const brainDb = path.join(tmp, '.cliodeck', 'brain.db');
    expect(readDbMarker(brainDb)).toBe('SQLITE');
    expect(stderr()).toMatch(/migration kind:/);
  });

  it('exits 1 when cliobrain config.json is malformed', async () => {
    await writeFile('.cliobrain/config.json', '{bad json');
    const code = await runCli(['import-cliobrain', tmp]);
    expect(code).toBe(1);
    const report = JSON.parse(stdout()) as { warnings: string[] };
    expect(report.warnings.some((w) => w.includes('Failed to parse'))).toBe(true);
  });

  it('reports noop when neither source exists', async () => {
    const code = await runCli(['import-cliobrain', tmp]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout()) as { kind: string; noop?: string };
    expect(report.kind).toBe('none');
    expect(report.noop).toBeDefined();
  });

  it('promotes a legacy-subdir workspace to flat', async () => {
    await writeFile(
      '.cliodeck/v2/config.json',
      JSON.stringify({ schema_version: 2, name: 'preexisting' }),
    );
    await writeFile('.cliodeck/v2/hints.md', '# h');

    const code = await runCli(['import-cliobrain', tmp]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout()) as { kind: string };
    expect(report.kind).toBe('legacy-subdir');
    expect(
      await fs.readFile(path.join(tmp, '.cliodeck', 'config.json'), 'utf8'),
    ).toMatch(/preexisting/);
  });
});
