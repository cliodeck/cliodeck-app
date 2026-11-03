/**
 * Une reconstruction des index a un état terminal, réussie ou non.
 *
 * L'échec publiait `{ current: 0, status: 'Error: …' }`, soit 0 %, et le renderer
 * en déduisait qu'elle commençait : un voile plein écran sans bouton, qui ne partait
 * plus. Ici le vrai store sur une vraie base, et une écriture rendue impossible comme
 * sur un disque réel : un répertoire à l'emplacement du fichier temporaire.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import type { RebuildProgressEvent } from '../../../types/rebuild-progress.js';
import { PdfVectorStore } from '../../../../src/main/services/pdf/PdfVectorStore.js';
import { EnhancedVectorStore } from '../EnhancedVectorStore.js';
import { VectorStore } from '../VectorStore.js';

let project = '';

/** Un corpus déjà indexé dans brain.db, sans index HNSW sur le disque. */
function seedChunks(count: number): void {
  const store = new VectorStore(project);
  const now = new Date();
  store.saveDocument({
    id: 'doc1',
    fileURL: path.join(project, 'a.pdf'),
    title: 'A',
    pageCount: 3,
    metadata: {},
    createdAt: now,
    indexedAt: now,
    lastAccessedAt: now,
    displayString: 'A',
  });
  for (let i = 0; i < count; i += 1) {
    const embedding = new Float32Array(768).map((_, j) => Math.sin(i * 7 + j));
    store.saveChunk(
      {
        id: `c${i}`,
        documentId: 'doc1',
        content: `Extrait ${i} sur les archives.`,
        pageNumber: 1,
        chunkIndex: i,
        startPosition: 0,
        endPosition: 10,
      },
      embedding
    );
  }
  store.close();
}

const cliodeck = (file: string) => path.join(project, '.cliodeck', file);

function openStore(): { store: EnhancedVectorStore; events: RebuildProgressEvent[] } {
  const store = new EnhancedVectorStore(project);
  const events: RebuildProgressEvent[] = [];
  store.setRebuildProgressCallback((event) => events.push(event));
  return { store, events };
}

describe.skipIf(!sqliteAvailable)('EnhancedVectorStore : la reconstruction se termine', () => {
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-reconstruction-'));
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('écriture impossible : le dernier événement est un échec, avec sa cause, là où elle s’est arrêtée', async () => {
    seedChunks(12);
    fs.mkdirSync(cliodeck('hnsw.index.meta.json.tmp'));
    const { store, events } = openStore();

    await expect(store.rebuildIndexes()).rejects.toThrow('Failed to save HNSW index');
    store.close();

    const last = events.at(-1);
    expect(last?.phase).toBe('failed');
    expect(last?.error).toMatch(/Failed to save HNSW index/);
    // Le pourcentage de l'échec n'est plus 0 : il disait « ça commence ».
    expect(last?.percentage).toBe(90);
    expect(events.slice(0, -1).map((e) => e.phase)).toEqual(events.slice(0, -1).map(() => 'running'));
  });

  it('sans ce répertoire : le dernier événement est un succès, à 100 %, sans erreur', async () => {
    seedChunks(12);
    const { store, events } = openStore();

    await store.rebuildIndexes();
    store.close();

    const last = events.at(-1);
    expect(last?.phase).toBe('done');
    expect(last?.percentage).toBe(100);
    expect(last?.error).toBeUndefined();
    expect(events.slice(0, -1).map((e) => e.phase)).toEqual(events.slice(0, -1).map(() => 'running'));
    expect(fs.existsSync(cliodeck('hnsw.index'))).toBe(true);
  });

  it('rien à indexer : l’autre sortie à 100 % est un succès aussi', async () => {
    const { store, events } = openStore();

    await store.rebuildIndexes();
    store.close();

    expect(events.at(-1)?.phase).toBe('done');
    expect(events.at(-1)?.percentage).toBe(100);
  });

  it('à l’ouverture du projet : l’échec est dit, et l’ouverture continue', async () => {
    seedChunks(12);
    fs.mkdirSync(cliodeck('hnsw.index.meta.json.tmp'));
    const { store, events } = openStore();

    await expect(store.initialize()).resolves.toBeUndefined();

    expect(events.at(-1)?.phase).toBe('failed');
    // La recherche garde l'index en mémoire, et la reconstruction reste due.
    expect((await store.getStats()).hnsw.currentSize).toBe(12);
    expect(store.needsRebuild()).toBe(true);
    store.close();
  });

  it('maybeRebuild sur un store fermé : ni levée synchrone dans le minuteur, ni rejet', async () => {
    seedChunks(3);
    const { store, events } = openStore();
    store.close();

    // Levé en synchrone, c'était une exception non rattrapée dans le setTimeout
    // de scheduleIndexRebuild : d'où un appel direct, sans `await` autour.
    let pending: Promise<void> | undefined;
    expect(() => {
      pending = PdfVectorStore.maybeRebuild(store);
    }).not.toThrow();
    await expect(pending).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });
});
