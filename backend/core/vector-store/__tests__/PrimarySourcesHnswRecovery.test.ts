/**
 * L'index HNSW des sources primaires après une sortie de l'app sans fermeture du magasin, et quand
 * son graphe se remplit (H7, revue).
 *
 * Les extraits s'écrivent en base au fil de l'eau, mais l'index HNSW ne s'écrivait sur disque qu'à
 * la fermeture du magasin et en fin de reconstruction, et `before-quit` sortait par `app.exit()`
 * sans fermer le magasin. Depuis L03-9, la sortie le ferme dans son échéance, et L06-6 écrit aussi
 * l'index après la réindexation d'une source ; un plantage, un arrêt forcé ou une échéance dépassée
 * laissent encore l'index d'avant. Après une sortie en pleine réindexation complète, la relance le
 * relisait : ses étiquettes pointaient vers des extraits supprimés, et les extraits refaits n'y
 * étaient pas. Le contrôle de `search` compare deux nombres, et il y en avait autant : les sources
 * refaites échappaient à la recherche dense. Quand la sortie tombait pendant la reconstruction
 * finale, plus aucune source n'était marquée, et c'était définitif.
 *
 * Pendant la passe, le graphe garde les points des anciens extraits jusqu'à la reconstruction
 * finale : 2N points pour N extraits. Au-delà de sa capacité (100 000), les vecteurs suivants
 * étaient abandonnés en silence, et la recherche finissait par tout reconstruire d'un bloc.
 *
 * Vrai magasin, vrai hnswlib, brain.db temporaire. La sortie sans fermeture est simulée en fermant
 * la base sans écrire l'index, comme un processus qui s'arrête après ses dernières transactions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import { PrimarySourcesVectorStore, type PrimarySourceChunk } from '../PrimarySourcesVectorStore.js';

let tmp = '';
const opened: PrimarySourcesVectorStore[] = [];

function unit(i: number): Float32Array {
  const v = new Float32Array(768);
  v[i % 768] = 1;
  v[(i * 7 + 3) % 768] += 0.5;
  return v;
}

function open(): PrimarySourcesVectorStore {
  const store = new PrimarySourcesVectorStore(tmp);
  opened.push(store);
  return store;
}

/** L'app tombée (plantage, arrêt forcé, échéance de sortie dépassée) : les transactions sont en base, l'index n'est pas écrit. */
function exitWithoutClosing(store: PrimarySourcesVectorStore): void {
  vi.spyOn(store, 'saveHNSWIndex').mockImplementation(() => undefined);
  store.close();
}

function chunk(sourceId: string, id: string, content: string, index = 0): PrimarySourceChunk {
  return { id, sourceId, content, chunkIndex: index, startPosition: 0, endPosition: content.length };
}

/** `count` sources d'un extrait chacune (`old-i`, vecteur `unit(i)`). */
function fillOld(store: PrimarySourcesVectorStore, count: number): void {
  for (let i = 1; i <= count; i++) {
    store.saveSource({
      id: `src-${i}`,
      tropyId: i,
      title: `Pièce ${i}`,
      tags: [],
      photos: [],
      transcription: `Corps de la pièce ${i}.`,
      transcriptionSource: 'tesseract',
      lastModified: new Date('2026-05-06T13:13:22.394Z'),
      metadata: {},
    });
    store.replaceSourceChunks(`src-${i}`, [
      { chunk: chunk(`src-${i}`, `old-${i}`, `pièce ${i} ancienne`), embedding: unit(i) },
    ]);
  }
}

/** Les extraits de la source `i` refaits (`new-i-k`, vecteurs `unit(100 * i + k)`). */
function redo(store: PrimarySourcesVectorStore, i: number, perSource = 1): void {
  store.replaceSourceChunks(
    `src-${i}`,
    Array.from({ length: perSource }, (_, k) => ({
      chunk: chunk(`src-${i}`, `new-${i}-${k}`, `pièce ${i} nouvelle ${k}`, k),
      embedding: unit(100 * i + k),
    }))
  );
}

/** Capacité du graphe ramenée à `capacity` points, pour simuler un corpus de plus de 50 000 extraits. */
function shrinkCapacity(store: PrimarySourcesVectorStore, capacity: number): void {
  (store as unknown as { hnswMaxElements: number }).hnswMaxElements = capacity;
  store.clearHNSWIndex();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-primary-recovery-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const store of opened.splice(0)) {
    try {
      store.close();
    } catch {
      /* déjà fermé */
    }
  }
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('PrimarySourcesVectorStore — index HNSW relu après une sortie sans fermeture', () => {
  it('une source refaite puis l’app quittée : la relance voit l’index en retard, et la reconstruction rend la source à la recherche dense', async () => {
    const first = open();
    fillOld(first, 10);
    first.close();
    const crashed = open();
    redo(crashed, 3);
    exitWithoutClosing(crashed);

    const relaunched = open();
    expect(relaunched.search(unit(300), 3).map((r) => r.chunk.id)).not.toContain('new-3-0');
    expect(relaunched.checkHnswIndex()).toMatchObject({ missing: 1, needsRebuild: true });

    expect(await relaunched.rebuildIndexesInSlices()).toBe(true);
    expect(relaunched.search(unit(300), 3)[0]?.chunk.id).toBe('new-3-0');
    expect(relaunched.checkHnswIndex()).toEqual({ missing: 0, stale: 0, needsRebuild: false, dimension: 768 });
  });

  it('toutes les sources refaites, l’app quittée pendant la reconstruction finale : la relance voit que l’index ne sert plus rien', () => {
    const first = open();
    fillOld(first, 10);
    first.close();
    const crashed = open();
    for (let i = 1; i <= 10; i++) redo(crashed, i);
    exitWithoutClosing(crashed);

    const relaunched = open();
    expect(relaunched.search(unit(300), 3)).toEqual([]);
    expect(relaunched.checkHnswIndex()).toEqual({ missing: 10, stale: 10, needsRebuild: true, dimension: 768 });
  });

  it('un index écrit à la fermeture n’est pas à reconstruire', () => {
    const first = open();
    fillOld(first, 10);
    first.close();

    expect(open().checkHnswIndex()).toEqual({ missing: 0, stale: 0, needsRebuild: false, dimension: 768 });
  });

  it('les points des extraits remplacés : à compacter au-delà de 10 % des points utiles, pas en deçà', () => {
    const first = open();
    fillOld(first, 20);
    redo(first, 1);
    redo(first, 2);
    first.close();
    const second = open();
    expect(second.checkHnswIndex()).toEqual({ missing: 0, stale: 2, needsRebuild: false, dimension: 768 });

    redo(second, 3);
    redo(second, 4);
    redo(second, 5);
    second.close();
    expect(open().checkHnswIndex()).toEqual({ missing: 0, stale: 5, needsRebuild: true, dimension: 768 });
  });

  it('pendant une reconstruction par tranches, la recherche ne reconstruit pas d’un bloc, même à plus de 10 % d’écart', async () => {
    const first = open();
    fillOld(first, 10);
    first.close();
    // Refaites en deux extraits chacune : 20 extraits en base, 10 étiquettes relues.
    const crashed = open();
    for (let i = 1; i <= 10; i++) redo(crashed, i, 2);
    exitWithoutClosing(crashed);

    const relaunched = open();
    const blockingRebuild = vi.spyOn(relaunched, 'rebuildAllIndexes');
    const rebuilding = relaunched.rebuildIndexesInSlices(4);
    relaunched.search(unit(300), 3);
    expect(blockingRebuild).not.toHaveBeenCalled();

    expect(await rebuilding).toBe(true);
    expect(relaunched.search(unit(301), 1)[0]?.chunk.id).toBe('new-3-1');
    expect(blockingRebuild).not.toHaveBeenCalled();
  });

  it('un extrait remplacé pendant la reconstruction n’a plus d’étiquette dans le nouvel index : la recherche suivante ne reconstruit pas d’un bloc', async () => {
    const store = open();
    fillOld(store, 10);
    // Juste après la lecture de la base : les anciens extraits sont déjà dans la reconstruction.
    const read = store.getAllChunksWithEmbeddings.bind(store);
    vi.spyOn(store, 'getAllChunksWithEmbeddings').mockImplementationOnce(() => {
      const snapshot = read();
      for (let i = 1; i <= 5; i++) redo(store, i);
      return snapshot;
    });
    expect(await store.rebuildIndexesInSlices(2)).toBe(true);

    const blockingRebuild = vi.spyOn(store, 'rebuildAllIndexes');
    expect(store.search(unit(300), 1)[0]?.chunk.id).toBe('new-3-0');
    expect(blockingRebuild).not.toHaveBeenCalled();
    expect(store.checkHnswIndex().missing).toBe(0);
  });
});

describe.skipIf(!sqliteAvailable)('PrimarySourcesVectorStore — graphe HNSW plein', () => {
  it('pendant la passe, le graphe garde les anciens points : sa capacité grandit, aucun vecteur n’est abandonné', () => {
    const store = open();
    shrinkCapacity(store, 12);
    fillOld(store, 10);
    for (let i = 1; i <= 3; i++) redo(store, i);

    expect(store.getIndexStats().hnswSize).toBe(13);
    expect(store.search(unit(300), 3)[0]?.chunk.id).toBe('new-3-0');

    for (let i = 4; i <= 5; i++) redo(store, i);
    const blockingRebuild = vi.spyOn(store, 'rebuildAllIndexes');
    expect(store.search(unit(500), 1)[0]?.chunk.id).toBe('new-5-0');
    expect(blockingRebuild).not.toHaveBeenCalled();
  });

  it('la reconstruction par tranches garde tous les extraits, au-delà de la capacité par défaut', async () => {
    const store = open();
    shrinkCapacity(store, 12);
    fillOld(store, 15);

    expect(await store.rebuildIndexesInSlices(4)).toBe(true);

    expect(store.getIndexStats().hnswSize).toBe(15);
    expect(store.checkHnswIndex()).toEqual({ missing: 0, stale: 0, needsRebuild: false, dimension: 768 });
    expect(store.search(unit(14), 1)[0]?.chunk.id).toBe('old-14');
  });
});
