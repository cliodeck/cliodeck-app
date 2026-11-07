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
import type {
  PrimarySourceItem,
  PrimarySourcePhoto,
} from '../../../integrations/tropy/TropyReader.js';

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

function photo(id: number, over: Partial<PrimarySourcePhoto> = {}): PrimarySourcePhoto {
  return {
    id,
    path: `/archives/scan-${id}.jpg`,
    filename: `scan-${id}.jpg`,
    hasTranscription: false,
    notes: [],
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

  // L06-5 (S02-1-10) : Tropy garde l'id d'une photo qu'il déplace d'un item à
  // l'autre (déplacement, fusion, scission). L'INSERT simple levait UNIQUE sur
  // `tropy_photos.id` tant que l'ancienne source n'avait pas été réécrite.
  it('une photo qui change d’item change de source, sans erreur UNIQUE (L06-5)', () => {
    store.saveSource(source({ id: 'src-B', tropyId: 8, photos: [photo(42)], tags: ['b'] }));
    store.saveSource(source({ id: 'src-A', tropyId: 5, photos: [photo(7)], tags: ['old'] }));

    // Fusion de B dans A : la photo 42 arrive avec sa note.
    expect(() =>
      store.saveSource(
        source({
          id: 'src-A',
          tropyId: 5,
          photos: [photo(7), photo(42, { hasTranscription: true, transcription: 'note de la page' })],
          tags: ['new'],
          transcription: 'texte A + B',
        })
      )
    ).not.toThrow();

    expect(store.getSourcePhotos('src-A').map((p) => p.id).sort((a, b) => a - b)).toEqual([7, 42]);
    expect(store.getSourcePhotos('src-A').find((p) => p.id === 42)).toMatchObject({
      hasTranscription: true,
      transcription: 'note de la page',
    });
    expect(store.getSourcePhotos('src-B')).toEqual([]);
    expect(store.getSourceTags('src-A')).toEqual(['new']);
    expect(store.getSource('src-A')?.transcription).toBe('texte A + B');
    // B garde sa ligne et ses tags : seule la photo a changé de main.
    expect(store.getSourceTags('src-B')).toEqual(['b']);
  });

  it('une écriture qui échoue en chemin ne laisse rien de la nouvelle version (L06-5)', () => {
    store.saveSource(
      source({
        photos: [photo(7)],
        tags: ['old'],
        transcription: 'ancien texte',
      })
    );
    store.saveChunk(
      {
        id: 'chunk-1',
        sourceId: 'src-1',
        content: 'ancien texte',
        chunkIndex: 0,
        startPosition: 0,
        endPosition: 12,
      },
      Float32Array.from(new Array(768).fill(0.01))
    );

    // Une vraie erreur SQLite au milieu de l'écriture : après la ligne et les
    // photos, pendant les tags.
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    db.exec(`
      CREATE TRIGGER refuse_tags BEFORE INSERT ON tropy_tags
      BEGIN SELECT RAISE(ABORT, 'écriture des tags refusée'); END;
    `);

    expect(() =>
      store.saveSource(
        source({
          photos: [photo(7), photo(8)],
          tags: ['new'],
          transcription: 'nouveau texte',
          lastModified: new Date('2026-06-01T08:00:00.000Z'),
        })
      )
    ).toThrow(/tags refusée/);

    // Tout tel qu'avant : sinon la passe suivante prend la nouvelle
    // transcription pour acquise et n'invalide jamais les extraits.
    const saved = store.getSource('src-1');
    expect(saved?.transcription).toBe('ancien texte');
    expect(saved?.lastModified).toBe('2026-05-06T13:13:22.394Z');
    expect(store.getSourcePhotos('src-1').map((p) => p.id)).toEqual([7]);
    expect(store.getSourceTags('src-1')).toEqual(['old']);
    expect(store.getChunks('src-1').map((c) => c.id)).toEqual(['chunk-1']);
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
    store.bindTropyProject(TPY, 'comité', 'uuid-comite', { autoSync: true });

    // La synchro appelle sans `autoSync` à chaque passe : elle ne doit pas
    // désactiver au passage un réglage de l'utilisateur.
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
    store.bindTropyProject(TPY, 'comité', 'uuid-comite', { autoSync: true });
    store.bindTropyProject(TPY, 'comité', 'uuid-comite', { autoSync: false });

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
    const id = store.bindTropyProject(TPY, 'comité', 'uuid-comite', { autoSync: true });
    expect(store.bindTropyProject(MOVED, 'comité', 'uuid-comite')).toBe(id);

    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const rows = db.prepare('SELECT id, tpy_path, auto_sync FROM tropy_projects').all();
    expect(rows).toEqual([{ id, tpy_path: MOVED, auto_sync: 1 }]);
  });

  it('met à jour la ligne que la garde a reconnue, même sans uuid ni chemin pour la retrouver', () => {
    // Ligne d'avant project_uuid, projet déplacé depuis : seule l'empreinte
    // des photos l'a reconnu. Une ligne neuve à sa place perdait la
    // surveillance, et perdrait tout ce que la ligne portera plus tard.
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    db.prepare(
      'INSERT INTO tropy_projects (id, tpy_path, name, last_sync, auto_sync) VALUES (?, ?, ?, ?, ?)'
    ).run('a', TPY, 'comité', '2026-08-01T00:00:00.000Z', 1);
    const MOVED = '/Volumes/Archives/comité.tropy';

    expect(store.bindTropyProject(MOVED, 'comité', 'uuid-comite', { keepId: 'a' })).toBe('a');

    const rows = db.prepare('SELECT id, tpy_path, auto_sync, project_uuid FROM tropy_projects').all();
    expect(rows).toEqual([{ id: 'a', tpy_path: MOVED, auto_sync: 1, project_uuid: 'uuid-comite' }]);
  });

  it('un autre projet au même chemin ne reprend pas la ligne de l’ancien', () => {
    // Le fichier a été remplacé par un autre projet Tropy, sans source liée
    // encore : la surveillance réglée pour l'ancien ne passe pas au nouveau.
    const first = store.bindTropyProject(TPY, 'comité', 'uuid-comite', { autoSync: true });
    const second = store.bindTropyProject(TPY, 'ddf_archives', 'uuid-ddf');

    expect(second).not.toBe(first);
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const rows = db.prepare('SELECT id, name, auto_sync, project_uuid FROM tropy_projects').all();
    expect(rows).toEqual([{ id: second, name: 'ddf_archives', auto_sync: 0, project_uuid: 'uuid-ddf' }]);
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
