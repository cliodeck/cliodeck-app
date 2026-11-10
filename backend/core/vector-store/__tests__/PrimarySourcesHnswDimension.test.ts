/**
 * L'index HNSW des sources primaires quand le modèle d'embeddings a changé de dimension (H7, revue).
 *
 * Les Paramètres proposent des modèles de 768, 1024 et 1536 dimensions. Après un changement, la
 * réindexation complète refait les extraits à la nouvelle dimension, source par source : pendant
 * la passe, et après une passe interrompue, la base mêle deux dimensions. Trois défauts en
 * venaient.
 *
 * - La recherche comptait les extraits de toutes les dimensions contre les vecteurs de l'index, qui
 *   ne sert qu'une dimension : à chaque question du chat, plus de 10 % d'écart, et une
 *   reconstruction d'un bloc, une centaine de secondes de gel du processus principal sur 40 000
 *   extraits, pendant toute la passe.
 * - L'index relu du disque était construit à la dimension de la première ligne de la base, pas à
 *   la sienne : à la réouverture d'un projet dont la passe s'était arrêtée, le premier extrait
 *   refait levait à l'ajout, après son écriture en base.
 * - La reconstruction prenait la dimension de la première ligne lue, quelle qu'elle soit.
 *
 * Vrai magasin, vrai hnswlib, brain.db temporaire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import { PrimarySourcesVectorStore, type PrimarySourceChunk } from '../PrimarySourcesVectorStore.js';

const OLD = 1024;
const NEW = 768;

let tmp = '';
const opened: PrimarySourcesVectorStore[] = [];

function vec(dimension: number, i: number): Float32Array {
  const v = new Float32Array(dimension);
  v[i % dimension] = 1;
  v[(i * 7 + 3) % dimension] += 0.5;
  return v;
}

function open(): PrimarySourcesVectorStore {
  const store = new PrimarySourcesVectorStore(tmp);
  opened.push(store);
  return store;
}

/** L'app quittée par `app.exit()` : les transactions sont en base, l'index n'est pas écrit. */
function exitWithoutClosing(store: PrimarySourcesVectorStore): void {
  vi.spyOn(store, 'saveHNSWIndex').mockImplementation(() => undefined);
  store.close();
}

function chunk(sourceId: string, id: string, content: string, index = 0): PrimarySourceChunk {
  return { id, sourceId, content, chunkIndex: index, startPosition: 0, endPosition: content.length };
}

/** `count` sources de trois extraits chacune (`old-i-k`), embarquées à l'ancienne dimension. */
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
    store.replaceSourceChunks(
      `src-${i}`,
      [0, 1, 2].map((k) => ({ chunk: chunk(`src-${i}`, `old-${i}-${k}`, `pièce ${i} ancienne ${k}`, k), embedding: vec(OLD, 10 * i + k) }))
    );
  }
}

/** Les extraits de la source `i` refaits à la nouvelle dimension (`new-i-k`, vecteurs `vec(NEW, 1000 + 10 i + k)`). */
function redo(store: PrimarySourcesVectorStore, i: number): void {
  store.replaceSourceChunks(
    `src-${i}`,
    [0, 1, 2].map((k) => ({ chunk: chunk(`src-${i}`, `new-${i}-${k}`, `pièce ${i} nouvelle ${k}`, k), embedding: vec(NEW, 1000 + 10 * i + k) }))
  );
}

/** Le premier extrait trouvé par la recherche dense seule, avec le vecteur de `new-i-0`. */
function denseTop(store: PrimarySourcesVectorStore, i: number): string | undefined {
  return store.search(vec(NEW, 1000 + 10 * i), 3)[0]?.chunk.id;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-primary-dimension-'));
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

describe.skipIf(!sqliteAvailable)('PrimarySourcesVectorStore — modèle d’embeddings changé de dimension', () => {
  it('pendant la passe : la question du chat ne reconstruit jamais d’un bloc, et chaque source refaite est trouvée par la recherche dense', () => {
    const first = open();
    fillOld(first, 20);
    first.close();

    const store = open();
    const blockingRebuild = vi.spyOn(store, 'rebuildAllIndexes');
    for (let i = 1; i <= 6; i++) {
      redo(store, i);
      expect(denseTop(store, i)).toBe(`new-${i}-0`);
    }
    expect(blockingRebuild).not.toHaveBeenCalled();
  });

  it('projet rouvert après une passe arrêtée : l’index relu garde sa dimension, et la suite de la passe s’y ajoute', () => {
    const first = open();
    fillOld(first, 20);
    first.close();
    const stopped = open();
    for (let i = 1; i <= 3; i++) redo(stopped, i);
    stopped.close();

    const reopened = open();
    // Levait « Invalid the given array length (expected 1024, but got 768) », extraits déjà en base.
    expect(() => redo(reopened, 4)).not.toThrow();
    expect(reopened.checkHnswIndex(NEW)).toEqual({ missing: 0, stale: 0, needsRebuild: false, dimension: NEW });
    const blockingRebuild = vi.spyOn(reopened, 'rebuildAllIndexes');
    for (const i of [1, 4]) expect(denseTop(reopened, i)).toBe(`new-${i}-0`);
    expect(blockingRebuild).not.toHaveBeenCalled();
  });

  it('l’app quittée en pleine passe : l’index relu, de l’ancienne dimension, est à refaire à celle du fournisseur, avec les sources déjà refaites', async () => {
    const first = open();
    fillOld(first, 20);
    first.close();
    const crashed = open();
    for (let i = 1; i <= 3; i++) redo(crashed, i);
    exitWithoutClosing(crashed);

    const relaunched = open();
    const check = relaunched.checkHnswIndex(NEW);
    expect(check).toEqual({ missing: 9, stale: 60, needsRebuild: true, dimension: NEW });

    expect(await relaunched.rebuildIndexesInSlices(4, check.dimension)).toBe(true);
    expect(relaunched.getIndexStats()).toMatchObject({ hnswSize: 9, hnswDimension: NEW });
    for (const i of [1, 2, 3]) expect(denseTop(relaunched, i)).toBe(`new-${i}-0`);
    // La passe reprend : la source suivante s'y ajoute, sans tout reconstruire.
    redo(relaunched, 4);
    expect(denseTop(relaunched, 4)).toBe('new-4-0');
    expect(relaunched.checkHnswIndex(NEW)).toEqual({ missing: 0, stale: 0, needsRebuild: false, dimension: NEW });
  });

  it('témoin : aucun extrait à la dimension du fournisseur, l’index garde la sienne et n’est pas à refaire', () => {
    const first = open();
    fillOld(first, 5);
    first.close();

    expect(open().checkHnswIndex(NEW)).toEqual({ missing: 0, stale: 0, needsRebuild: false, dimension: OLD });
  });

  it('la reconstruction par tranches se fait à la dimension demandée, sans les extraits d’une autre', async () => {
    const store = open();
    fillOld(store, 10);
    for (let i = 1; i <= 2; i++) redo(store, i);

    expect(await store.rebuildIndexesInSlices(4, NEW)).toBe(true);

    expect(store.getIndexStats()).toMatchObject({ hnswSize: 6, hnswDimension: NEW });
    expect(denseTop(store, 2)).toBe('new-2-0');
  });
});

describe.skipIf(!sqliteAvailable)('PrimarySourcesVectorStore — la recherche ne reconstruit jamais d’un bloc', () => {
  it('index en retard sur la base : la recherche répond aussitôt avec l’index courant, et il se reconstruit par tranches, en arrière-plan', async () => {
    const first = open();
    fillOld(first, 10);
    first.close();
    // Quatre sources embarquées par une synchro, puis l'app quittée : leurs 12 extraits manquent à
    // l'index relu, plus de 10 % d'écart.
    const crashed = open();
    for (let i = 11; i <= 14; i++) {
      crashed.saveSource({
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
      crashed.replaceSourceChunks(
        `src-${i}`,
        [0, 1, 2].map((k) => ({ chunk: chunk(`src-${i}`, `new-${i}-${k}`, `pièce ${i} nouvelle ${k}`, k), embedding: vec(OLD, 500 + 10 * i + k) }))
      );
    }
    exitWithoutClosing(crashed);

    const relaunched = open();
    const blockingRebuild = vi.spyOn(relaunched, 'rebuildAllIndexes');
    // L'index courant sert : les sources qu'il a sont trouvées.
    expect(relaunched.search(vec(OLD, 50), 1)[0]?.chunk.id).toBe('old-5-0');
    expect(blockingRebuild).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(relaunched.checkHnswIndex().needsRebuild).toBe(false));
    expect(relaunched.search(vec(OLD, 620), 1)[0]?.chunk.id).toBe('new-12-0');
    expect(blockingRebuild).not.toHaveBeenCalled();
  });

  it('témoin : un modèle d’une autre dimension que tous les extraits fait toujours échouer la recherche, sans rien reconstruire', () => {
    const first = open();
    fillOld(first, 5);
    first.close();

    const store = open();
    const blockingRebuild = vi.spyOn(store, 'rebuildAllIndexes');
    const slices = vi.spyOn(store, 'rebuildIndexesInSlices');
    expect(() => store.search(vec(NEW, 1), 3)).toThrow(/expected 1024, but got 768/);
    expect(blockingRebuild).not.toHaveBeenCalled();
    expect(slices).not.toHaveBeenCalled();
  });
});
