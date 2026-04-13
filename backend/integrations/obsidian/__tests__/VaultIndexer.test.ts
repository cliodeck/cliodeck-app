import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { ObsidianVaultReader } from '../ObsidianVaultReader.js';
import { ObsidianVaultStore } from '../ObsidianVaultStore.js';
import { ObsidianVaultIndexer } from '../ObsidianVaultIndexer.js';
import type { EmbeddingProvider } from '../../../core/llm/providers/base.js';

const DIMENSION = 8;

function fakeEmbedder(): EmbeddingProvider {
  return {
    id: 'fake-embed',
    name: 'fake',
    model: 'fake',
    dimension: DIMENSION,
    getStatus: () => ({ state: 'ready', lastReadyAt: 'now' }),
    healthCheck: async () => ({ state: 'ready', lastReadyAt: 'now' }),
    embed: async (texts) => {
      // Deterministic toy embedding: histogram of char codes % DIMENSION,
      // L2-normalized. Gives related texts correlated vectors, enough
      // for search tests to be non-trivial without a real model.
      return texts.map((t) => {
        const v = new Array<number>(DIMENSION).fill(0);
        for (const ch of t) v[ch.charCodeAt(0) % DIMENSION] += 1;
        const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / n);
      });
    },
    dispose: async () => undefined,
  };
}

let vault = '';
let store: ObsidianVaultStore | null = null;

async function mkVault(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'cliodeck-vault-'));
}
function writeNote(rel: string, content: string): void {
  const p = path.join(vault, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

beforeEach(async () => {
  vault = await mkVault();
});
afterEach(async () => {
  store?.close();
  store = null;
  await fsp.rm(vault, { recursive: true, force: true });
});

describe('ObsidianVaultIndexer (2.4b)', () => {
  it('indexes a small vault and produces a VaultScanReport', async () => {
    writeNote(
      'History/DeGaulle.md',
      '---\ntags: [wwii, france]\n---\n# De Gaulle\n\nAppel du 18 juin 1940 depuis Londres. [[Vichy]].\n'
    );
    writeNote('Notes/Idea.md', '# Idea\nRandom musings about totalitarianism.');
    writeNote('Notes/Empty.md', '');

    const reader = new ObsidianVaultReader(vault);
    store = new ObsidianVaultStore({
      dbPath: path.join(vault, '.cliodeck', 'v2', 'obsidian-vectors.db'),
      dimension: DIMENSION,
    });
    const indexer = new ObsidianVaultIndexer(reader, store, fakeEmbedder());

    const report = await indexer.indexAll();

    expect(report.stats.indexedCount).toBe(2);
    expect(report.stats.skippedCount).toBe(1);
    expect(report.skipped[0].reason.kind).toBe('empty_note');

    const stats = store.stats();
    expect(stats.noteCount).toBe(2);
    expect(stats.chunkCount).toBeGreaterThan(0);
  });

  it('is incremental: unchanged notes are not re-embedded', async () => {
    writeNote('A.md', '# A\nhello world hello world.');
    const reader = new ObsidianVaultReader(vault);
    store = new ObsidianVaultStore({
      dbPath: path.join(vault, '.cliodeck', 'v2', 'obsidian-vectors.db'),
      dimension: DIMENSION,
    });
    let embedCalls = 0;
    const embedder = fakeEmbedder();
    const originalEmbed = embedder.embed;
    embedder.embed = async (texts) => {
      embedCalls += texts.length;
      return originalEmbed(texts);
    };
    const indexer = new ObsidianVaultIndexer(reader, store, embedder);

    await indexer.indexAll();
    const firstCallCount = embedCalls;
    await indexer.indexAll();
    expect(embedCalls).toBe(firstCallCount); // no re-embed

    // force: true re-embeds
    await indexer.indexAll({ force: true });
    expect(embedCalls).toBeGreaterThan(firstCallCount);
  });

  it('search returns hybrid-ranked hits with dense + lexical signals', async () => {
    writeNote(
      'Petain.md',
      '# Pétain\nArmistice de juin 1940. Régime de Vichy.'
    );
    writeNote('DeGaulle.md', '# De Gaulle\nAppel du 18 juin 1940 depuis Londres.');
    writeNote('Unrelated.md', 'Recipe for ratatouille: tomatoes, zucchini, eggplant.');

    const reader = new ObsidianVaultReader(vault);
    store = new ObsidianVaultStore({
      dbPath: path.join(vault, '.cliodeck', 'v2', 'obsidian-vectors.db'),
      dimension: DIMENSION,
    });
    const embedder = fakeEmbedder();
    const indexer = new ObsidianVaultIndexer(reader, store, embedder);
    await indexer.indexAll();

    const [qVec] = await embedder.embed(['Appel du 18 juin Londres']);
    const hits = store.search(
      Float32Array.from(qVec),
      'Appel du 18 juin Londres',
      3
    );

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].note.title).toBe('De Gaulle');
    expect(hits[0].signals.dense).toBeGreaterThan(0);
  });

  it('handles a malformed FTS query by falling back to dense-only', async () => {
    writeNote('A.md', '# A\ncontent.');
    const reader = new ObsidianVaultReader(vault);
    store = new ObsidianVaultStore({
      dbPath: path.join(vault, '.cliodeck', 'v2', 'obsidian-vectors.db'),
      dimension: DIMENSION,
    });
    const embedder = fakeEmbedder();
    const indexer = new ObsidianVaultIndexer(reader, store, embedder);
    await indexer.indexAll();

    const [qVec] = await embedder.embed(['anything']);
    // Operators-only queries used to crash FTS MATCH; the escape should tolerate.
    const hits = store.search(Float32Array.from(qVec), '* AND ( )', 3);
    expect(Array.isArray(hits)).toBe(true);
  });

  it('oversized notes are skipped with typed reason', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024); // > 2 MB
    writeNote('Big.md', big);

    const reader = new ObsidianVaultReader(vault);
    store = new ObsidianVaultStore({
      dbPath: path.join(vault, '.cliodeck', 'v2', 'obsidian-vectors.db'),
      dimension: DIMENSION,
    });
    const indexer = new ObsidianVaultIndexer(reader, store, fakeEmbedder());
    const report = await indexer.indexAll();

    expect(report.stats.indexedCount).toBe(0);
    expect(report.stats.skippedCount).toBe(1);
    const reason = report.skipped[0].reason;
    expect(reason.kind).toBe('oversized');
  });
});
