/**
 * L'index HNSW des sources primaires, écrit vide puis relu.
 *
 * `close()` écrit l'index même vide : tout projet ouvert puis fermé avant d'avoir des extraits
 * Tropy laisse un `primary-hnsw.index` sans élément. hnswlib relit un tel fichier avec une
 * capacité nulle, et le premier extrait ajouté levait « The number of elements exceeds the
 * specified limit » — après l'écriture des extraits en base. La synchro comptait la source en
 * échec d'embarquement, et la réindexation complète (H7) s'arrêtait à chaque ouverture après une
 * seule source, en accusant le modèle de recherche sémantique. Trouvé en mesurant le coût de H7.
 *
 * Vrai magasin, vrai hnswlib, brain.db temporaire.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import { PrimarySourcesVectorStore, type PrimarySourceChunk } from '../PrimarySourcesVectorStore.js';

let tmp = '';

function unit(i: number): Float32Array {
  const v = new Float32Array(768);
  v[i % 768] = 1;
  return v;
}

function chunk(id: string, content: string): PrimarySourceChunk {
  return { id, sourceId: 'src-1', content, chunkIndex: 0, startPosition: 0, endPosition: content.length };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-primary-hnsw-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('PrimarySourcesVectorStore — index HNSW écrit vide puis relu', () => {
  it('un projet ouvert et fermé sans extrait : les premiers extraits s’ajoutent à l’index à la réouverture', () => {
    // Première session : aucun extrait Tropy ; la fermeture écrit l'index vide.
    new PrimarySourcesVectorStore(tmp).close();
    expect(fs.existsSync(path.join(tmp, '.cliodeck', 'primary-hnsw.index'))).toBe(true);

    // Seconde session : le projet Tropy est lié, sa première source s'indexe.
    const store = new PrimarySourcesVectorStore(tmp);
    try {
      store.saveSource({
        id: 'src-1',
        tropyId: 10,
        title: 'Rapport du commissaire',
        tags: [],
        photos: [],
        transcription: 'Le commissaire signale huit cents grévistes salle Colbert.',
        transcriptionSource: 'tesseract',
        lastModified: new Date('2026-05-06T13:13:22.394Z'),
        metadata: {},
      });
      expect(() =>
        store.replaceSourceChunks('src-1', [
          { chunk: chunk('c1', 'huit cents grévistes salle Colbert'), embedding: unit(1) },
          { chunk: chunk('c2', 'le commissaire central au préfet'), embedding: unit(2) },
        ])
      ).not.toThrow();
      expect(store.getIndexStats().hnswSize).toBe(2);
      expect(store.search(unit(1), 1)[0]?.chunk.id).toBe('c1');
    } finally {
      store.close();
    }
  });

  it('témoin : un index non vide relu garde sa capacité', () => {
    const first = new PrimarySourcesVectorStore(tmp);
    first.saveSource({
      id: 'src-1',
      tropyId: 10,
      title: 'Rapport du commissaire',
      tags: [],
      photos: [],
      transcription: 'Texte.',
      transcriptionSource: 'tesseract',
      lastModified: new Date('2026-05-06T13:13:22.394Z'),
      metadata: {},
    });
    first.replaceSourceChunks('src-1', [{ chunk: chunk('c1', 'huit cents grévistes'), embedding: unit(1) }]);
    first.close();

    const store = new PrimarySourcesVectorStore(tmp);
    try {
      expect(() =>
        store.replaceSourceChunks('src-1', [{ chunk: chunk('c2', 'salle Colbert'), embedding: unit(2) }])
      ).not.toThrow();
    } finally {
      store.close();
    }
  });
});
