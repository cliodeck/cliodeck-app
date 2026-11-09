import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteAvailable } from '@backend/__tests__/helpers/native-guards';
import Database from 'better-sqlite3';
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
  vi.useRealTimers();
  store?.close();
  store = null;
  await fsp.rm(vault, { recursive: true, force: true });
});

// Suite SQLite : gardée par sqliteAvailable (ABI better-sqlite3 vs node de
// vitest — cf. backend/__tests__/helpers/native-guards.ts).
describe.skipIf(!sqliteAvailable)('ObsidianVaultIndexer (2.4b)', () => {
  it('indexes a small vault and produces a VaultScanReport', async () => {
    writeNote(
      'History/DeGaulle.md',
      '---\ntags: [wwii, france]\n---\n# De Gaulle\n\nAppel du 18 juin 1940 depuis Londres. [[Vichy]].\n'
    );
    writeNote('Notes/Idea.md', '# Idea\nRandom musings about totalitarianism.');
    writeNote('Notes/Empty.md', '');

    const reader = new ObsidianVaultReader(vault);
    store = new ObsidianVaultStore({
      dbPath: path.join(vault, '.cliodeck', 'brain.db'),
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
      dbPath: path.join(vault, '.cliodeck', 'brain.db'),
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
      dbPath: path.join(vault, '.cliodeck', 'brain.db'),
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
    // Path A′ : le rang lexical accompagne le cosinus, pour le contrat de
    // pertinence commun — `score` reste un RRF, non comparable.
    expect(hits[0].signals.lexicalRank).toBe(1);
    const unrelated = hits.find((h) => h.note.title !== 'De Gaulle' && h.signals.lexical === 0);
    if (unrelated) expect(unrelated.signals.lexicalRank).toBeNull();
  });

  it('handles a malformed FTS query by falling back to dense-only', async () => {
    writeNote('A.md', '# A\ncontent.');
    const reader = new ObsidianVaultReader(vault);
    store = new ObsidianVaultStore({
      dbPath: path.join(vault, '.cliodeck', 'brain.db'),
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
      dbPath: path.join(vault, '.cliodeck', 'brain.db'),
      dimension: DIMENSION,
    });
    const indexer = new ObsidianVaultIndexer(reader, store, fakeEmbedder());
    const report = await indexer.indexAll();

    expect(report.stats.indexedCount).toBe(0);
    expect(report.stats.skippedCount).toBe(1);
    const reason = report.skipped[0].reason;
    expect(reason.kind).toBe('oversized');
  });

  it('rejects non-finite embeddings before writing to sqlite', async () => {
    // Regression: a NaN or Infinity slipped through to the BLOB insert
    // corrupted future reads and in one observed case preceded a
    // SIGSEGV in the native binding. The store must refuse the write
    // loud, not silently persist poison.
    writeNote('A.md', '# A\nhello');

    const reader = new ObsidianVaultReader(vault);
    store = new ObsidianVaultStore({
      dbPath: path.join(vault, '.cliodeck', 'brain.db'),
      dimension: DIMENSION,
    });

    const nanEmbedder: EmbeddingProvider = {
      ...fakeEmbedder(),
      embed: async (texts) =>
        texts.map(() => {
          const v = new Array<number>(DIMENSION).fill(0.1);
          v[3] = NaN;
          return v;
        }),
    };
    const indexer = new ObsidianVaultIndexer(reader, store, nanEmbedder);

    const report = await indexer.indexAll();
    expect(report.stats.failedCount).toBe(1);
    expect(report.failed[0].reason.kind).toBe('io_error');
    expect(
      (report.failed[0].reason as { kind: 'io_error'; message: string }).message
    ).toMatch(/non-finite/);
    // Nothing from the poison batch should reach the table.
    expect(store.stats().chunkCount).toBe(0);
  });
});

/** Ollama arrêté : chaque appel échoue. */
function stoppedEmbedder(): EmbeddingProvider {
  return {
    ...fakeEmbedder(),
    embed: async () => {
      throw new Error('fetch failed (Ollama arrêté)');
    },
  };
}

/** Un fournisseur qui répond, mais avec un vecteur que `addChunk` refuse : l'échec arrive à l'écriture. */
function nanEmbedder(): EmbeddingProvider {
  return {
    ...fakeEmbedder(),
    embed: async (texts) =>
      texts.map(() => {
        const v = new Array<number>(DIMENSION).fill(0.1);
        v[3] = NaN;
        return v;
      }),
  };
}

/** Le contenu réel des tables, lu par une autre connexion : ce que la recherche verra. */
function tables(): { notes: number; chunks: number; hash: string | null; text: string } {
  const db = new Database(path.join(vault, '.cliodeck', 'brain.db'), { readonly: true });
  try {
    const count = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const note = db.prepare("SELECT file_hash FROM obsidian_notes WHERE relative_path = 'A.md'").get() as
      | { file_hash: string }
      | undefined;
    const rows = db.prepare('SELECT content FROM obsidian_chunks').all() as Array<{ content: string }>;
    return {
      notes: count('obsidian_notes'),
      chunks: count('obsidian_chunks'),
      hash: note?.file_hash ?? null,
      text: rows.map((r) => r.content).join('\n'),
    };
  } finally {
    db.close();
  }
}

/**
 * S02-1-3 : l'empreinte d'une note s'écrivait avant ses embeddings. Ollama arrêté, la note
 * gardait sa nouvelle empreinte sans aucun extrait, et la passe suivante la tenait pour indexée :
 * elle sortait de la recherche, « 0 échec » au rapport.
 */
describe.skipIf(!sqliteAvailable)('ObsidianVaultIndexer — panne pendant l’indexation', () => {
  function openStore(): ObsidianVaultStore {
    store = new ObsidianVaultStore({
      dbPath: path.join(vault, '.cliodeck', 'brain.db'),
      dimension: DIMENSION,
    });
    return store;
  }

  it('Ollama arrêté puis relancé : la passe suivante embarque la note', async () => {
    writeNote('A.md', '# Vichy\nLe régime de Vichy et la collaboration.');
    const reader = new ObsidianVaultReader(vault);
    openStore();

    const down = await new ObsidianVaultIndexer(reader, store!, stoppedEmbedder()).indexAll();
    expect(down.stats.failedCount).toBe(1);
    expect(down.failed[0].reason.kind).toBe('io_error');

    const up = await new ObsidianVaultIndexer(reader, store!, fakeEmbedder()).indexAll();
    expect(up.stats).toMatchObject({ indexedCount: 1, failedCount: 0 });
    expect(store!.stats().chunkCount).toBeGreaterThan(0);
    expect(store!.searchLexical('collaboration', 5)).toHaveLength(1);
  });

  it('note déjà indexée puis modifiée, Ollama arrêté : ses anciens extraits restent, à l’empreinte d’avant', async () => {
    writeNote('A.md', '# Vichy\nLe régime de Vichy et la collaboration.');
    const reader = new ObsidianVaultReader(vault);
    openStore();
    await new ObsidianVaultIndexer(reader, store!, fakeEmbedder()).indexAll();
    const before = tables();
    expect(before.chunks).toBeGreaterThan(0);

    writeNote('A.md', '# Vichy\nLe régime de Vichy, la collaboration et la Milice.');
    const down = await new ObsidianVaultIndexer(reader, store!, stoppedEmbedder()).indexAll();

    expect(down.stats.failedCount).toBe(1);
    expect(tables()).toEqual(before);
    expect(store!.searchLexical('collaboration', 5)).toHaveLength(1);

    // Ollama relancé : la nouvelle version entre dans l'index.
    await new ObsidianVaultIndexer(reader, store!, fakeEmbedder()).indexAll();
    expect(tables().hash).not.toBe(before.hash);
    expect(tables().text).toContain('Milice');
  });

  it('une note déjà tenue pour indexée sans aucun extrait est réembarquée', async () => {
    // L'état que laissait le défaut sur les postes : empreinte à jour, zéro extrait.
    writeNote('A.md', '# Vichy\nLe régime de Vichy et la collaboration.');
    const reader = new ObsidianVaultReader(vault);
    openStore();
    await new ObsidianVaultIndexer(reader, store!, fakeEmbedder()).indexAll();
    const db = new Database(path.join(vault, '.cliodeck', 'brain.db'));
    db.exec('DELETE FROM obsidian_chunks; DELETE FROM obsidian_chunks_fts;');
    db.close();
    expect(tables()).toMatchObject({ notes: 1, chunks: 0 });

    let embedded = 0;
    const embedder = fakeEmbedder();
    const embed = embedder.embed;
    embedder.embed = async (texts) => {
      embedded += texts.length;
      return embed(texts);
    };
    const report = await new ObsidianVaultIndexer(reader, store!, embedder).indexAll();

    expect(report.stats.indexedCount).toBe(1);
    expect(embedded).toBeGreaterThan(0);
    expect(store!.searchLexical('collaboration', 5)).toHaveLength(1);
  });

  it('une erreur SQLite sur une note est un échec partiel : la passe continue', async () => {
    writeNote('A.md', '# Vichy\nLe régime de Vichy et la collaboration.');
    writeNote('B.md', '# Londres\nAppel du 18 juin 1940.');
    writeNote('C.md', '# Alger\nLe Comité français de libération nationale.');
    const reader = new ObsidianVaultReader(vault);
    openStore();
    // Une vraie erreur SQLite, levée par la base elle-même, sur la seule note B.
    const db = new Database(path.join(vault, '.cliodeck', 'brain.db'));
    db.exec(`CREATE TRIGGER refuse_b BEFORE INSERT ON obsidian_notes WHEN NEW.relative_path = 'B.md'
             BEGIN SELECT RAISE(ABORT, 'écriture refusée'); END;`);
    db.close();

    const report = await new ObsidianVaultIndexer(reader, store!, fakeEmbedder()).indexAll();

    expect(report.stats).toMatchObject({ indexedCount: 2, failedCount: 1 });
    expect(report.failed[0].ref.relativePath).toBe('B.md');
    expect(report.failed[0].reason).toMatchObject({ kind: 'io_error', message: expect.stringMatching(/écriture refusée/) });
    expect(store!.searchLexical('Comité', 5)).toHaveLength(1);
    // Rien de B : ni sa note, ni un extrait orphelin.
    expect(store!.getNoteByPath('B.md')).toBeNull();
    expect(store!.searchLexical('Appel', 5)).toEqual([]);
  });

  /**
   * Tout ou rien : l'échec arrive APRÈS l'écriture de la nouvelle empreinte et l'effacement des
   * anciens extraits, au premier `addChunk`. Sans transaction, la note passait à sa nouvelle
   * empreinte sans aucun extrait : S02-1-3 par un autre chemin que la panne du fournisseur.
   */
  it.each([
    {
      cas: 'un vecteur non fini',
      prepare: (): EmbeddingProvider => nanEmbedder(),
      message: /non-finite/,
    },
    {
      cas: 'une erreur SQLite à l’écriture d’un extrait',
      prepare: (): EmbeddingProvider => {
        const db = new Database(path.join(vault, '.cliodeck', 'brain.db'));
        db.exec(`CREATE TRIGGER refuse_extrait BEFORE INSERT ON obsidian_chunks
                 BEGIN SELECT RAISE(ABORT, 'écriture refusée'); END;`);
        db.close();
        return fakeEmbedder();
      },
      message: /écriture refusée/,
    },
  ])(
    'note déjà indexée puis modifiée, $cas : empreinte et extraits restent ceux d’avant',
    async ({ prepare, message }) => {
      writeNote('A.md', '# Vichy\nLe régime de Vichy et la collaboration.');
      const reader = new ObsidianVaultReader(vault);
      openStore();
      await new ObsidianVaultIndexer(reader, store!, fakeEmbedder()).indexAll();
      const before = tables();
      expect(before.chunks).toBeGreaterThan(0);

      writeNote('A.md', '# Vichy\nLe régime de Vichy, la collaboration et la Milice.');
      const report = await new ObsidianVaultIndexer(reader, store!, prepare()).indexAll();

      expect(report.stats).toMatchObject({ indexedCount: 0, failedCount: 1 });
      expect(report.failed[0].reason).toMatchObject({ kind: 'io_error', message: expect.stringMatching(message) });
      expect(tables()).toEqual(before);
      expect(store!.searchLexical('collaboration', 5)).toHaveLength(1);
    }
  );

  /**
   * « Détacher » efface les tables du coffre pendant que la passe attend le fournisseur. Une erreur
   * propre à une note reste un échec partiel, mais des tables disparues ne sont pas l'affaire d'une
   * note : continuer enverrait au fournisseur, peut-être en ligne, toutes les notes d'un coffre que
   * l'auteur vient de retirer, pour un rapport « N échecs ».
   */
  it.each([{ force: true }, { force: false }])(
    'Détacher pendant une passe (force: $force) : la passe s’arrête après l’appel en cours',
    async ({ force }) => {
      const dbPath = path.join(vault, '.cliodeck', 'brain.db');
      for (const nom of ['A', 'B', 'C', 'D', 'E', 'F']) writeNote(`${nom}.md`, `# ${nom}\nPremière version de ${nom}.`);
      const reader = new ObsidianVaultReader(vault);
      openStore();
      await new ObsidianVaultIndexer(reader, store!, fakeEmbedder()).indexAll();
      // Toutes modifiées : une passe non forcée les réembarque aussi.
      for (const nom of ['A', 'B', 'C', 'D', 'E', 'F']) writeNote(`${nom}.md`, `# ${nom}\nSeconde version de ${nom}.`);

      let calls = 0;
      const embedder = fakeEmbedder();
      const embed = embedder.embed;
      embedder.embed = async (texts) => {
        calls += 1;
        if (calls === 1) ObsidianVaultStore.purgeObsidianData(dbPath);
        return embed(texts);
      };

      await expect(new ObsidianVaultIndexer(reader, store!, embedder).indexAll({ force })).rejects.toThrow(
        /no such table/
      );
      expect(calls).toBe(1);
      // Rien de recréé : le coffre détaché ne laisse aucune table derrière la passe.
      const db = new Database(dbPath, { readonly: true });
      const restantes = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'obsidian_%'").all();
      db.close();
      expect(restantes).toEqual([]);
    }
  );

  it('témoin : une note sans rien à découper reste indexée, sans appel au fournisseur ni réécriture', async () => {
    writeNote('A.md', '---\ntags: [brouillon]\n---\n');
    const reader = new ObsidianVaultReader(vault);
    openStore();
    let calls = 0;
    const embedder = fakeEmbedder();
    const embed = embedder.embed;
    embedder.embed = async (texts) => {
      calls += 1;
      return embed(texts);
    };

    // Horloge figée, puis avancée d'une minute entre les deux passes : une réécriture de la note
    // change `indexedAt` à coup sûr. Sur l'horloge réelle, les deux passes tombaient une fois sur
    // deux dans la même milliseconde et la réécriture passait inaperçue.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-09T10:00:00.000Z') });
    const first = await new ObsidianVaultIndexer(reader, store!, embedder).indexAll();
    const indexedAt = store!.getNoteByPath('A.md')?.indexedAt;
    vi.setSystemTime(new Date('2026-11-09T10:01:00.000Z'));
    const second = await new ObsidianVaultIndexer(reader, store!, embedder).indexAll();

    expect(indexedAt).toBe('2026-11-09T10:00:00.000Z');
    expect(first.stats.indexedCount).toBe(1);
    expect(second.stats.indexedCount).toBe(1);
    expect(calls).toBe(0);
    expect(store!.getNoteByPath('A.md')?.indexedAt).toBe(indexedAt);
    expect(tables()).toMatchObject({ notes: 1, chunks: 0 });
  });
});
