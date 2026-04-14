import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { runCli } from '../cliodeck-cli.js';
import {
  defaultWorkspaceConfig,
  writeWorkspaceConfig,
} from '../../backend/core/workspace/config.js';
import { ensureV2Directories } from '../../backend/core/workspace/layout.js';

let tmp = '';
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-cli-'));
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

function stdout(): string {
  return stdoutChunks.join('');
}
function stderr(): string {
  return stderrChunks.join('');
}

async function initWorkspace(): Promise<void> {
  await ensureV2Directories(tmp);
  await writeWorkspaceConfig(tmp, defaultWorkspaceConfig('cli-test'));
}

describe('cliodeck CLI (4.6)', () => {
  it('prints usage with --help', async () => {
    const code = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout()).toMatch(/cliodeck —/);
  });

  it('recipe list surfaces builtin recipes as JSON', async () => {
    const code = await runCli(['recipe', 'list']);
    expect(code).toBe(0);
    const arr = JSON.parse(stdout()) as Array<{
      source: string;
      name: string;
    }>;
    expect(arr.length).toBeGreaterThan(0);
    expect(arr.every((r) => r.source === 'builtin')).toBe(true);
    expect(arr.map((r) => r.name)).toContain('revue-zotero');
  });

  it('hints set + show round-trips via the workspace', async () => {
    await initWorkspace();
    const setCode = await runCli([
      'hints',
      'set',
      '--workspace',
      tmp,
      'Cite toujours en Chicago.',
    ]);
    expect(setCode).toBe(0);
    stdoutChunks = [];

    const showCode = await runCli(['hints', 'show', '--workspace', tmp]);
    expect(showCode).toBe(0);
    const parsed = JSON.parse(stdout()) as {
      present: boolean;
      content: string;
    };
    expect(parsed.present).toBe(true);
    expect(parsed.content).toBe('Cite toujours en Chicago.');
  });

  it('search returns empty hits when the vault store is absent', async () => {
    await initWorkspace();
    const code = await runCli(['search', 'anything', '--workspace', tmp]);
    // Store will throw on open because no DB — surface as runtime error (1).
    expect([0, 1]).toContain(code);
    if (code === 0) {
      const parsed = JSON.parse(stdout()) as { hits: unknown[] };
      expect(parsed.hits).toEqual([]);
    } else {
      expect(stderr()).toMatch(/error:/);
    }
  });

  it('missing --workspace on hints show returns usage error 2', async () => {
    const code = await runCli(['hints', 'show']);
    expect(code).toBe(2);
    expect(stderr()).toMatch(/workspace/);
  });

  it('unknown subcommand prints usage and exits 2', async () => {
    const code = await runCli(['bogus']);
    expect(code).toBe(2);
    expect(stderr()).toMatch(/cliodeck —/);
  });
});
