/**
 * Les index en mémoire des sources primaires quand les extraits d'une source sont remplacés.
 *
 * `replaceSourceChunks` ajoutait les nouveaux vecteurs à HNSW et BM25 sans rien retirer : BM25
 * servait encore le texte des anciens extraits (un ancien titre, une transcription corrigée), et
 * la recherche, qui compare le nombre de points du graphe HNSW à celui des extraits en base,
 * déclenchait au-delà de 10 % d'écart une reconstruction complète, d'un bloc. Sur un corpus de la
 * taille d'AnalyseDDF (40 650 extraits), elle gèle le processus principal une centaine de secondes
 * (mesuré pour H7) : la réindexation complète l'aurait provoquée à chaque question du chat.
 *
 * La reconstruction de fin de passe (H7) se fait par tranches : le processus principal reprend la
 * main entre deux, et l'ancien index sert les recherches jusqu'au remplacement.
 *
 * Vrai magasin, vrai hnswlib, brain.db temporaire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import { PrimarySourcesVectorStore, type PrimarySourceChunk } from '../PrimarySourcesVectorStore.js';

let tmp = '';
let store: PrimarySourcesVectorStore;

function unit(i: number): Float32Array {
  const v = new Float32Array(768);
  v[i % 768] = 1;
  v[(i * 7 + 3) % 768] += 0.5;
  return v;
}

function addSource(id: string, title: string): void {
  store.saveSource({
    id,
    tropyId: Number(id.replace(/\D/g, '')) || 1,
    title,
    tags: [],
    photos: [],
    transcription: `Corps de ${title}.`,
    transcriptionSource: 'tesseract',
    lastModified: new Date('2026-05-06T13:13:22.394Z'),
    metadata: {},
  });
}

function chunk(sourceId: string, id: string, content: string, index = 0): PrimarySourceChunk {
  return { id, sourceId, content, chunkIndex: index, startPosition: 0, endPosition: content.length };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-primary-replace-'));
  store = new PrimarySourcesVectorStore(tmp);
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    store.close();
  } catch {
    /* déjà fermé */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('PrimarySourcesVectorStore — remplacer les extraits d’une source', () => {
  it('BM25 ne sert plus le texte des anciens extraits', () => {
    // Vingt sources : un remplacement fait moins de 10 % d'écart, pas de reconstruction.
    for (let i = 1; i <= 20; i++) {
      addSource(`src-${i}`, `Pièce ${i}`);
      store.replaceSourceChunks(`src-${i}`, [{ chunk: chunk(`src-${i}`, `c${i}`, `pièce ${i} registre commun`), embedding: unit(i) }]);
    }
    store.replaceSourceChunks('src-7', [
      { chunk: chunk('src-7', 'c7-old', '[Doc: Lettre à Xavier] mon cher Xavier'), embedding: unit(70) },
    ]);
    store.replaceSourceChunks('src-7', [
      { chunk: chunk('src-7', 'c7-new', '[Doc: Lettre à Yves] mon cher Yves'), embedding: unit(71) },
    ]);

    const results = store.search(unit(70), 10, 'Xavier');
    expect(results.filter((r) => r.chunk.content.includes('Xavier'))).toEqual([]);
    expect(store.search(unit(71), 10, 'Yves').some((r) => r.chunk.id === 'c7-new')).toBe(true);
  });

  it('tous les extraits remplacés : la recherche ne reconstruit pas les index d’un bloc', () => {
    for (let i = 1; i <= 5; i++) {
      addSource(`src-${i}`, `Pièce ${i}`);
      store.replaceSourceChunks(`src-${i}`, [{ chunk: chunk(`src-${i}`, `old-${i}`, `pièce ${i} ancienne`), embedding: unit(i) }]);
    }
    for (let i = 1; i <= 5; i++) {
      store.replaceSourceChunks(`src-${i}`, [{ chunk: chunk(`src-${i}`, `new-${i}`, `pièce ${i} nouvelle`), embedding: unit(i + 10) }]);
    }
    const rebuild = vi.spyOn(store, 'rebuildAllIndexes');

    // Recherche dense seule : la fusion avec BM25 départagerait des extraits ex æquo.
    const results = store.search(unit(13), 3);

    expect(rebuild).not.toHaveBeenCalled();
    expect(results[0]?.chunk.id).toBe('new-3');
    expect(results.every((r) => r.chunk.id.startsWith('new-'))).toBe(true);
  });
});

describe.skipIf(!sqliteAvailable)('PrimarySourcesVectorStore — reconstruction par tranches', () => {
  function fill(sources: number, perSource: number, prefix: string): void {
    for (let s = 1; s <= sources; s++) {
      if (!store.getSource(`src-${s}`)) addSource(`src-${s}`, `Pièce ${s}`);
      store.replaceSourceChunks(
        `src-${s}`,
        Array.from({ length: perSource }, (_, k) => ({
          chunk: chunk(`src-${s}`, `${prefix}-${s}-${k}`, `${prefix} pièce ${s} extrait ${k}`, k),
          embedding: unit(s * 100 + k + (prefix === 'new' ? 50 : 0)),
        }))
      );
    }
  }

  it('rend la main entre deux tranches, et laisse un index compact, aux seuls extraits en base', async () => {
    fill(4, 50, 'old');
    fill(4, 50, 'new');
    expect(store.getIndexStats().hnswSize).toBe(400);

    let ticks = 0;
    const ticker = setInterval(() => (ticks += 1), 0);
    try {
      expect(await store.rebuildIndexesInSlices(20)).toBe(true);
    } finally {
      clearInterval(ticker);
    }

    expect(ticks).toBeGreaterThan(0);
    expect(store.getIndexStats()).toMatchObject({ hnswSize: 200, bm25Size: 200 });
    expect(store.search(unit(2 * 100 + 7 + 50), 1)[0]?.chunk.id).toBe('new-2-7');
  });

  it('un extrait écrit pendant la reconstruction est dans le nouvel index', async () => {
    fill(2, 50, 'old');
    const rebuilding = store.rebuildIndexesInSlices(10);
    addSource('src-9', 'Pièce 9');
    store.replaceSourceChunks('src-9', [{ chunk: chunk('src-9', 'late', 'écrit pendant la reconstruction'), embedding: unit(500) }]);
    expect(await rebuilding).toBe(true);

    expect(store.getIndexStats().hnswSize).toBe(101);
    expect(store.search(unit(500), 1)[0]?.chunk.id).toBe('late');
  });

  it('le magasin fermé en route : rien n’est remplacé, rien ne lève', async () => {
    fill(2, 50, 'old');
    const rebuilding = store.rebuildIndexesInSlices(10);
    store.close();
    await expect(rebuilding).resolves.toBe(false);
  });
});
