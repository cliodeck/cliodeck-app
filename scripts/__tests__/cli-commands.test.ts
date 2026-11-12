import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { runCli } from '../cliodeck-cli.js';
import {
  defaultWorkspaceConfig,
  writeWorkspaceConfig,
} from '../../backend/core/workspace/config.js';
import { ensureWorkspaceDirectories } from '../../backend/core/workspace/layout.js';

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
  await ensureWorkspaceDirectories(tmp);
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

  it('rag-benchmark runs the harness on a synthetic fixture', async () => {
    const corpusPath = path.join(tmp, 'corpus.json');
    const queriesPath = path.join(tmp, 'queries.json');
    await fs.writeFile(
      corpusPath,
      JSON.stringify([
        {
          id: 'd1',
          chunks: [{ id: 'd1-c1', content: 'Bataille de Verdun en 1916.' }],
        },
        {
          id: 'd2',
          chunks: [{ id: 'd2-c1', content: 'Recette ratatouille tomates.' }],
        },
      ])
    );
    await fs.writeFile(
      queriesPath,
      JSON.stringify([
        { id: 'q1', text: 'Verdun 1916', relevant: ['d1-c1'] },
        { id: 'q2', text: 'ratatouille', relevant: ['d2-c1'] },
      ])
    );
    const code = await runCli([
      'rag-benchmark',
      '--corpus',
      corpusPath,
      '--queries',
      queriesPath,
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout()) as {
      retriever: string;
      recall: Record<string, number>;
      hitRate: Record<string, number>;
      mrr: number;
    };
    expect(parsed.retriever).toBe('bm25');
    expect(parsed.mrr).toBe(1);
    // Un seul pertinent par question : rappel et taux de succès coïncident.
    expect(parsed.recall[1]).toBe(1);
    expect(parsed.hitRate[1]).toBe(1);
  });

  // Le jeu de contrôle versionné (docs/path-a-readiness.md) : le relevé de référence et celui de
  // L07-3 se font dessus, par les deux retrievers.
  it('rag-benchmark passe le jeu de contrôle par les deux retrievers, journaux sur stderr', async () => {
    const fixtures = path.resolve(__dirname, '../../test-fixtures/rag-benchmark');
    const corpusPath = path.join(fixtures, 'corpus.json');
    const queriesPath = path.join(fixtures, 'queries.json');
    const corpus = JSON.parse(await fs.readFile(corpusPath, 'utf8')) as Array<{
      chunks: Array<{ id: string }>;
    }>;
    const queries = JSON.parse(await fs.readFile(queriesPath, 'utf8')) as Array<{
      id: string;
      relevant: string[];
    }>;
    const chunkIds = corpus.flatMap((d) => d.chunks.map((c) => c.id));
    expect(new Set(chunkIds).size).toBe(chunkIds.length);
    expect(queries.length).toBeLessThanOrEqual(20);
    expect(queries.some((q) => q.id.startsWith('fr-'))).toBe(true);
    expect(queries.some((q) => q.id.startsWith('de-'))).toBe(true);
    for (const q of queries) {
      expect(q.relevant.length).toBeGreaterThan(0);
      for (const id of q.relevant) expect(chunkIds).toContain(id);
    }

    for (const retriever of ['bm25', 'pdf-lexical']) {
      stdoutChunks = [];
      // `BM25Index` et `HybridSearch` écrivent par `console.log` : sur stdout, ils casseraient le JSON.
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const code = await runCli([
        'rag-benchmark',
        '--corpus',
        corpusPath,
        '--queries',
        queriesPath,
        '--retriever',
        retriever,
      ]);
      expect(code).toBe(0);
      expect(log).not.toHaveBeenCalled();
      if (retriever === 'pdf-lexical') expect(error).toHaveBeenCalled();
      log.mockRestore();
      error.mockRestore();
      const parsed = JSON.parse(stdout()) as {
        retriever: string;
        queryCount: number;
        recall: Record<string, number>;
        hitRate: Record<string, number>;
        perQuery: Array<{ queryId: string; relevantCount: number }>;
      };
      expect(parsed.retriever).toBe(retriever);
      expect(parsed.queryCount).toBe(queries.length);
      expect(Object.keys(parsed.recall)).toEqual(['1', '3', '5', '10']);
      expect(Object.keys(parsed.hitRate)).toEqual(['1', '3', '5', '10']);
      expect(parsed.perQuery.map((q) => q.queryId)).toEqual(queries.map((q) => q.id));
    }
  });

  it('rag-benchmark refuse un retriever inconnu et nomme les deux', async () => {
    const code = await runCli([
      'rag-benchmark',
      '--corpus',
      'c.json',
      '--queries',
      'q.json',
      '--retriever',
      'dense',
    ]);
    expect(code).toBe(2);
    expect(stderr()).toMatch(/bm25, pdf-lexical/);
  });

  it('rag-benchmark missing flags returns usage error 2', async () => {
    const code = await runCli(['rag-benchmark']);
    expect(code).toBe(2);
    expect(stderr()).toMatch(/usage/);
  });
});
