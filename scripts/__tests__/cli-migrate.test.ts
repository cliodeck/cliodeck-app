import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { runCli } from '../cliodeck-cli.js';

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

  it('migrates a minimal cliobrain workspace and prints a JSON report', async () => {
    await writeFile('.cliobrain/brain.db', 'SQLITE');
    await writeFile('.cliobrain/hnsw.index', 'VEC');
    await writeFile(
      '.cliobrain/config.json',
      JSON.stringify({ name: 'thesis', custom: 'kept' })
    );

    const code = await runCli(['import-cliobrain', tmp]);
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout()) as {
      cliobrain: { copied: unknown[]; skipped: unknown[]; warnings: unknown[] };
      cliodeckV1: { copied: unknown[]; skipped: unknown[] };
    };
    expect(parsed.cliobrain.copied.length).toBeGreaterThan(0);

    // The v2 layout should now hold the copied files.
    const brainDb = path.join(tmp, '.cliodeck', 'v2', 'brain.db');
    expect(await fs.readFile(brainDb, 'utf8')).toBe('SQLITE');
    expect(stderr()).toMatch(/cliobrain → v2:/);
  });

  it('exits 1 when cliobrain config.json is malformed', async () => {
    await writeFile('.cliobrain/config.json', '{bad json');
    const code = await runCli(['import-cliobrain', tmp]);
    expect(code).toBe(1);
    const report = JSON.parse(stdout()) as {
      cliobrain: { warnings: string[] };
    };
    expect(report.cliobrain.warnings.some((w) => w.includes('Failed to parse'))).toBe(
      true
    );
  });

  it('reports noop on both sides when neither source exists', async () => {
    const code = await runCli(['import-cliobrain', tmp]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout()) as {
      cliobrain: { noop?: string };
      cliodeckV1: { noop?: string };
    };
    expect(report.cliobrain.noop).toBeDefined();
    expect(report.cliodeckV1.noop).toBeDefined();
  });
});
