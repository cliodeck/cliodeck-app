/**
 * Persistance des sources primaires et du projet Tropy lié.
 *
 * Deux pièges SQLite, tous deux mesurés sur un projet réel :
 *  — `saveSource` faisait `INSERT OR REPLACE`, qui SUPPRIME la ligne en
 *    conflit ; avec `foreign_keys = ON` et des filles en `ON DELETE
 *    CASCADE`, réenregistrer une source emportait ses chunks (46 → 0) ;
 *  — `saveTropyProject` résolvait son conflit sur un `randomUUID()` neuf à
 *    chaque appel, donc jamais : une ligne de plus par synchronisation.
 *    Devenu `bindTropyProject` (L06-3), qui porte aussi l'identité du projet.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import { PrimarySourcesVectorStore } from '../PrimarySourcesVectorStore.js';
import type { PrimarySourceItem } from '../../../integrations/tropy/TropyReader.js';

let tmp = '';
let store: PrimarySourcesVectorStore;

const TPY = '/Users/historienne/Documents/comité.tropy';

function source(over: Partial<PrimarySourceItem> = {}): PrimarySourceItem {
  return {
    id: 'src-1',
    tropyId: 305,
    title: 'Minutes de la 141e réunion',
    tags: ['comité'],
    photos: [],
    transcription: 'PROCES-VERBAL',
    transcriptionSource: 'tesseract',
    lastModified: new Date('2026-05-06T13:13:22.394Z'),
    metadata: {},
    ...over,
  };
}

describe.skipIf(!sqliteAvailable)('PrimarySourcesVectorStore — sources', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-primary-src-'));
    store = new PrimarySourcesVectorStore(tmp);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('conserve les chunks quand la source est réenregistrée', () => {
    store.saveSource(source());
    store.saveChunk(
      {
        id: 'chunk-1',
        sourceId: 'src-1',
        content: 'PROCES-VERBAL DE LA 141e REUNION',
        chunkIndex: 0,
        startPosition: 0,
        endPosition: 32,
      },
      Float32Array.from(new Array(768).fill(0.01))
    );
    expect(store.getChunks('src-1')).toHaveLength(1);

    // Simple mise à jour de métadonnées : les chunks n'ont aucune raison
    // de disparaître — c'est pourtant ce que faisait REPLACE + CASCADE.
    store.saveSource(source({ title: 'Titre corrigé' }));

    expect(store.getSource('src-1')?.title).toBe('Titre corrigé');
    expect(store.getChunks('src-1')).toHaveLength(1);
  });

  it('met bien à jour la transcription au réenregistrement', () => {
    store.saveSource(source());
    store.saveSource(source({ transcription: 'texte revu', transcriptionSource: 'manual' }));

    const saved = store.getSource('src-1');
    expect(saved?.transcription).toBe('texte revu');
    expect(saved?.transcriptionSource).toBe('manual');
    // Une seule ligne, pas deux.
    expect(store.getAllSources()).toHaveLength(1);
  });

  it('distingue « pas de note » de « notes pas encore lues » (notes_text, L06-2)', () => {
    // '' : la synchro a lu l'item, il n'a pas de note. NULL : ligne d'avant la
    // colonne, que la synchro initialise sans réembarquer. Les confondre
    // ferait soit tout réembarquer, soit ne jamais embarquer une note ajoutée.
    store.saveSource(source({ notesText: '' }));
    expect(store.getSource('src-1')?.notesText).toBe('');

    store.saveSource(source({ notesText: 'Voir aussi carton 12' }));
    expect(store.getSource('src-1')?.notesText).toBe('Voir aussi carton 12');
    expect(store.getSource('src-1')?.transcription).toBe('PROCES-VERBAL');

    store.saveSource(source({ id: 'src-2', tropyId: 306 }));
    expect(store.getSource('src-2')?.notesText).toBeUndefined();
  });
});

describe.skipIf(!sqliteAvailable)('PrimarySourcesVectorStore — projet Tropy lié', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-primary-'));
    store = new PrimarySourcesVectorStore(tmp);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('garde une seule ligne quel que soit le nombre de synchronisations', () => {
    const first = store.bindTropyProject(TPY, 'comité', 'uuid-comite');
    store.bindTropyProject(TPY, 'comité', 'uuid-comite');
    store.bindTropyProject(TPY, 'comité', 'uuid-comite');

    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const count = db.prepare('SELECT COUNT(*) as c FROM tropy_projects').get() as { c: number };
    expect(count.c).toBe(1);

    const project = store.getTropyProject();
    expect(project?.id).toBe(first);
    expect(project?.tpyPath).toBe(TPY);
  });

  it('préserve la surveillance automatique quand la synchro ne la mentionne pas', () => {
    store.bindTropyProject(TPY, 'comité', 'uuid-comite', true);

    // La synchro appelle sans quatrième argument à chaque passe : elle ne
    // doit pas désactiver au passage un réglage de l'utilisateur.
    store.bindTropyProject(TPY, 'comité', 'uuid-comite');

    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const rows = db.prepare('SELECT auto_sync FROM tropy_projects').all() as Array<{
      auto_sync: number;
    }>;
    // Une seule ligne, et elle a gardé le réglage.
    expect(rows).toEqual([{ auto_sync: 1 }]);
    expect(store.getTropyProject()?.autoSync).toBe(true);
  });

  it('laisse la synchro modifier explicitement la surveillance', () => {
    store.bindTropyProject(TPY, 'comité', 'uuid-comite', true);
    store.bindTropyProject(TPY, 'comité', 'uuid-comite', false);

    expect(store.getTropyProject()?.autoSync).toBe(false);
  });

  it('absorbe les doublons hérités des versions précédentes', () => {
    // Doublons tels que les produisait l'ancienne implémentation.
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const insert = db.prepare(
      'INSERT INTO tropy_projects (id, tpy_path, name, last_sync, auto_sync) VALUES (?, ?, ?, ?, ?)'
    );
    insert.run('a', TPY, 'comité', '2026-08-01T00:00:00.000Z', 0);
    insert.run('b', TPY, 'comité', '2026-08-02T00:00:00.000Z', 0);
    insert.run('c', TPY, 'comité', '2026-08-03T00:00:00.000Z', 0);

    store.bindTropyProject(TPY, 'comité', null);

    const count = db
      .prepare('SELECT COUNT(*) as c FROM tropy_projects WHERE tpy_path = ?')
      .get(TPY) as { c: number };
    expect(count.c).toBe(1);
    // La plus récente est celle qui survit.
    expect(store.getTropyProject()?.id).toBe('c');
  });

  it('un appel qui ne connaît pas l’uuid ne l’efface pas (A5)', () => {
    // REPLACE réécrivait la ligne avec les seules colonnes nommées.
    store.bindTropyProject(TPY, 'comité', 'uuid-comite');
    store.bindTropyProject(TPY, 'comité', null);

    expect(store.getTropyProject()?.projectUuid).toBe('uuid-comite');
  });

  it('retrouve le projet par son uuid avant son chemin : déplacé, il garde sa ligne et sa surveillance', () => {
    const MOVED = '/Volumes/Archives/comité.tropy';
    const id = store.bindTropyProject(TPY, 'comité', 'uuid-comite', true);
    expect(store.bindTropyProject(MOVED, 'comité', 'uuid-comite')).toBe(id);

    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const rows = db.prepare('SELECT id, tpy_path, auto_sync FROM tropy_projects').all();
    expect(rows).toEqual([{ id, tpy_path: MOVED, auto_sync: 1 }]);
  });

  it('un projet sans source remplacé par un autre : une seule ligne, celle du nouveau', () => {
    store.bindTropyProject(TPY, 'comité', 'uuid-comite');
    store.bindTropyProject('/Users/historienne/Documents/ddf.tropy', 'ddf_archives', 'uuid-ddf');

    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const rows = db.prepare('SELECT name, project_uuid FROM tropy_projects').all();
    expect(rows).toEqual([{ name: 'ddf_archives', project_uuid: 'uuid-ddf' }]);
  });

  it('complète l’uuid d’une ligne ancienne sans toucher à sa date de synchro', () => {
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    db.prepare(
      'INSERT INTO tropy_projects (id, tpy_path, name, last_sync, auto_sync) VALUES (?, ?, ?, ?, ?)'
    ).run('a', TPY, 'comité', '2026-08-01T00:00:00.000Z', 0);

    store.recordTropyProjectUuid('a', 'uuid-comite');
    // Une identité déjà connue ne se réécrit pas.
    store.recordTropyProjectUuid('a', 'uuid-autre');

    expect(store.getTropyProject()).toMatchObject({
      projectUuid: 'uuid-comite',
      lastSync: '2026-08-01T00:00:00.000Z',
    });
  });
});
