/**
 * Une lecture ratée du .tpy ne passe plus pour un projet vide (J6).
 *
 * `TropyReader` rattrapait presque toutes ses erreurs de lecture et rendait du
 * vide : `listItems` une liste vide, chaque lecture par item (métadonnées,
 * étiquettes, notes, photos, sélections) un tableau ou un objet vide. La
 * synchro lisait ce vide comme un état réel : une table `items` illisible
 * donnait « synchro réussie, 0 item », et la date de dernière synchro
 * avançait ; un item dont les photos ne se lisaient pas était réenregistré
 * sans elles, et ses photos disparaissaient de brain.db.
 *
 * Vrais .tpy (`makeTpy`), abîmés par le test ; vrais `TropyReader`,
 * `tropyService`, handlers IPC et brain.db. Une erreur qui ne touche qu'un
 * sujet (une page de la base illisible) est simulée sur la seule requête de
 * ce sujet, à la connexion au .tpy (`failRead`) : c'est une erreur de SQLite,
 * levée là où SQLite la lèverait. Simulés aussi : Electron, la configuration,
 * le fournisseur d'embeddings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards';
import { makeTpy, openTpyForWrite, tpyDatabasePath, type TpyItemSpec } from './helpers/make-tpy';
import { TropyReader } from '../TropyReader';
import { assessTropyBinding, readTropyProjectIdentity } from '../tropy-project-identity';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = vi.hoisted(() => new Map<string, Handler>());

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
  BrowserWindow: { getAllWindows: () => [] },
  app: { commandLine: { hasSwitch: () => false }, getPath: () => os.tmpdir() },
}));

vi.mock('../../../../src/main/services/config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:1' }),
    getRAGConfig: () => ({ similarityThreshold: 0 }),
    getAPIKey: () => '',
    get: () => undefined,
    set: () => undefined,
  },
}));

vi.mock('../../../core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => ({
    getLLM: () => null,
    getEmbedding: () => ({
      id: 'local-test',
      name: 'local-test',
      model: 'constant',
      dimension: 8,
      getStatus: () => ({ state: 'ready' }),
      healthCheck: async () => ({ state: 'ready' }),
      embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]),
      dispose: async () => undefined,
    }),
    dispose: async () => undefined,
  }),
}));

const { setupTropyHandlers } = await import('../../../../src/main/ipc/handlers/tropy-handlers.js');
const { tropyService } = await import('../../../../src/main/services/tropy-service.js');
setupTropyHandlers();

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return Promise.resolve(handler({ sender: null }, ...args) as T);
}

// MARK: - Données

let root: string;
let projectDir: string;
let tropyDir: string;

/** Trois items ; celui du milieu porte une photo, une sélection et des notes à chaque niveau. */
function items(titleSuffix = '', modified?: string): TpyItemSpec[] {
  const photo = (name: string) => path.join(tropyDir, name);
  return [
    {
      id: 10,
      title: `Rapport du préfet${titleSuffix}`,
      modified,
      tags: ['grève'],
      photos: [{ id: 11, path: photo('rapport.jpg') }],
    },
    {
      id: 20,
      title: `Lettre du commissaire${titleSuffix}`,
      modified,
      creator: 'Commissaire central',
      tags: ['police'],
      notes: [{ text: 'note de l’item' }],
      photos: [
        {
          id: 21,
          path: photo('lettre.jpg'),
          notes: [{ text: 'note de la photo' }],
          selections: [{ id: 22, x: 5, y: 6, notes: [{ text: 'note de la sélection' }] }],
        },
      ],
    },
    {
      id: 30,
      title: `Affiche du comité${titleSuffix}`,
      modified,
      photos: [{ id: 31, path: photo('affiche.jpg') }],
    },
  ];
}

function writeTpy(titleSuffix = '', modified?: string, wal = false): string {
  return makeTpy(tropyDir, {
    projectId: 'tropy-greves',
    name: 'Grèves nantaises',
    items: items(titleSuffix, modified),
    wal,
  });
}

/** Modifie le .tpy comme le ferait un fichier abîmé ou un schéma inattendu. */
function alterTpy(tpy: string, sql: string): void {
  const db = openTpyForWrite(tpy);
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(sql);
  } finally {
    db.close();
  }
}

/**
 * Une lecture du .tpy qui échoue pour un seul sujet (item, photo, sélection),
 * comme une page de la base devenue illisible : sur la connexion au .tpy, la
 * requête que `pattern` reconnaît lève l'erreur de SQLite quand elle porte sur
 * `subjectId`. Rend l'espion, à restaurer pour « réparer » la base.
 */
function failRead(tpy: string, pattern: RegExp, subjectId: number) {
  const prepare = Database.prototype.prepare;
  const dbPath = tpyDatabasePath(tpy);
  return vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    source: string
  ) {
    const statement = prepare.call(this, source);
    if (this.name !== dbPath || !pattern.test(source)) return statement;
    return new Proxy(statement, {
      get(target, property) {
        if (property === 'all') {
          return (...params: unknown[]) => {
            if (params[0] === subjectId) {
              throw new Database.SqliteError('database disk image is malformed', 'SQLITE_CORRUPT');
            }
            return Reflect.apply(target.all, target, params) as unknown;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  } as typeof prepare);
}

/** L'erreur levée par `read`, ou `undefined` si la lecture a rendu quelque chose. */
function thrown(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Tout ce que brain.db garde des sources primaires, ligne à ligne. */
function brainState(): Record<string, string[]> {
  const db = new Database(path.join(projectDir, '.cliodeck', 'brain.db'), { readonly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tropy\\_%' ESCAPE '\\' ORDER BY name")
      .all() as Array<{ name: string }>;
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        (db.prepare(`SELECT * FROM "${name}"`).all() as unknown[]).map((row) => JSON.stringify(row)).sort(),
      ])
    );
  } finally {
    db.close();
  }
}

function photosOf(tropyId: number): number[] {
  const db = new Database(path.join(projectDir, '.cliodeck', 'brain.db'), { readonly: true });
  try {
    return (
      db
        .prepare(
          `SELECT p.id FROM tropy_photos p JOIN tropy_sources s ON s.id = p.source_id
           WHERE s.tropy_id = ? ORDER BY p.id`
        )
        .all(tropyId) as Array<{ id: number }>
    ).map((row) => row.id);
  } finally {
    db.close();
  }
}

const noOcr = { performOCR: false, ocrLanguage: 'fra' };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-j6-'));
  projectDir = path.join(root, 'projet-cliodeck');
  tropyDir = path.join(root, 'tropy');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(tropyDir, { recursive: true });
  for (const name of ['rapport.jpg', 'lettre.jpg', 'affiche.jpg']) {
    fs.writeFileSync(path.join(tropyDir, name), 'jpeg factice');
  }
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await tropyService.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// MARK: - TropyReader

describe.skipIf(!sqliteAvailable)('TropyReader : une lecture ratée lève TropyReadError (J6)', () => {
  it('une table items illisible : listItems lève, au lieu de rendre « 0 item »', () => {
    const tpy = writeTpy();
    alterTpy(tpy, 'ALTER TABLE items RENAME TO items_abimee');

    const reader = new TropyReader();
    reader.openProject(tpy);
    try {
      expect(thrown(() => reader.listItems())).toMatchObject({
        name: 'TropyReadError',
        method: 'listItems',
        message: expect.stringContaining('no such table: items'),
      });
      expect(thrown(() => reader.getItem(20))).toMatchObject({ name: 'TropyReadError', method: 'getItem' });
    } finally {
      reader.closeProject();
    }
  });

  it.each([
    ['getItemMetadata', /FROM metadata m/, 20],
    ['getItemTags', /JOIN taggings/, 20],
    ['getItemNotes', /FROM notes WHERE id = \?/, 20],
    ['getItemPhotos', /FROM photos p[\s\S]*p\.item_id = \?/, 20],
    ['getPhotoNotes', /FROM notes WHERE id = \?/, 21],
    ['getPhotoSelections', /FROM selections s/, 21],
    ['getSelectionNotes', /FROM notes WHERE id = \?/, 22],
  ] as const)('%s échoue pour un sujet de l’item du milieu : l’item n’est pas lu « sans »', (method, pattern, subjectId) => {
    const tpy = writeTpy();
    failRead(tpy, pattern, subjectId);

    const reader = new TropyReader();
    reader.openProject(tpy);
    try {
      const error = { name: 'TropyReadError', method, subjectId };
      expect(thrown(() => reader.listItems())).toMatchObject(error);
      expect(thrown(() => reader.getItem(20))).toMatchObject(error);
      // Les autres items se lisent : seule la page abîmée fait défaut.
      expect(reader.getItem(10)?.photos.map((p) => p.id)).toEqual([11]);
    } finally {
      reader.closeProject();
    }
  });

  it('les métadonnées brutes d’un item : elles lèvent aussi', () => {
    const tpy = writeTpy();
    failRead(tpy, /FROM metadata m/, 20);
    const reader = new TropyReader();
    reader.openProject(tpy);
    try {
      expect(thrown(() => reader.getAllItemMetadataRaw(20))).toMatchObject({
        name: 'TropyReadError',
        method: 'getAllItemMetadataRaw',
        subjectId: 20,
      });
    } finally {
      reader.closeProject();
    }
  });

  it('une table photos illisible : listAllPhotos lève, au lieu de rendre « aucune photo »', () => {
    const tpy = writeTpy();
    alterTpy(tpy, 'ALTER TABLE photos RENAME TO photos_abimee');
    const reader = new TropyReader();
    reader.openProject(tpy);
    try {
      expect(thrown(() => reader.listAllPhotos())).toMatchObject({
        name: 'TropyReadError',
        method: 'listAllPhotos',
        message: expect.stringContaining('no such table'),
      });
    } finally {
      reader.closeProject();
    }
  });

  it('un item absent du projet n’est pas une erreur : getItem rend null', () => {
    const reader = new TropyReader();
    reader.openProject(writeTpy());
    try {
      expect(reader.getItem(99)).toBeNull();
    } finally {
      reader.closeProject();
    }
  });
});

// MARK: - Schéma ancien

describe.skipIf(!sqliteAvailable)('TropyReader : un schéma ancien se relève, il ne se devine pas à l’erreur (J6)', () => {
  // `photos.filename` vient de la migration 2103171215 (Tropy 1.10). Un projet
  // qu'aucun Tropy plus récent n'a rouvert ne l'a pas : la requête des photos
  // échouait, et chaque item était lu sans aucune photo.
  it('Tropy 1.9 ou plus ancien, sans photos.filename : les photos se lisent, leur nom tiré du chemin', () => {
    const tpy = writeTpy();
    alterTpy(tpy, 'ALTER TABLE photos DROP COLUMN filename');

    const reader = new TropyReader();
    reader.openProject(tpy);
    try {
      const listed = reader.listItems().find((item) => item.id === 20);
      expect(listed?.photos.map((p) => [p.id, p.filename, p.path])).toEqual([
        [21, 'lettre.jpg', path.join(tropyDir, 'lettre.jpg')],
      ]);
      expect(listed?.photos[0].selections[0].notes.map((n) => n.text)).toEqual(['note de la sélection']);
      expect(reader.getItem(10)?.photos.map((p) => p.filename)).toEqual(['rapport.jpg']);
      expect(reader.listAllPhotos().map(({ photo }) => photo.filename).sort()).toEqual([
        'affiche.jpg',
        'lettre.jpg',
        'rapport.jpg',
      ]);
    } finally {
      reader.closeProject();
    }
  });

  // La table `selections` vient de la migration 1708121306 (août 2017, bêtas
  // de Tropy 1.0) : sans elle, aucune photo n'a de sélection.
  it('avant la table selections : les photos et leurs notes se lisent, sans sélection', () => {
    const tpy = writeTpy();
    alterTpy(tpy, 'DROP TABLE selections');

    const reader = new TropyReader();
    reader.openProject(tpy);
    try {
      const [photo] = reader.getItem(20)?.photos ?? [];
      expect(photo?.id).toBe(21);
      expect(photo?.notes.map((n) => n.text)).toEqual(['note de la photo']);
      expect(photo?.selections).toEqual([]);
    } finally {
      reader.closeProject();
    }
  });
});

// MARK: - Synchro

describe.skipIf(!sqliteAvailable)('TropySync : une lecture ratée fait échouer la synchro, et rien n’est écrit (J6)', () => {
  it('une table items illisible : échec, avis « projet Tropy illisible », brain.db inchangé jusqu’à la date de synchro', async () => {
    const tpy = writeTpy();
    await tropyService.init(projectDir);
    expect((await tropyService.openProject(tpy)).success).toBe(true);
    expect((await tropyService.sync(noOcr)).success).toBe(true);
    const before = brainState();
    expect(before.tropy_sources).toHaveLength(3);

    // L'horloge avance : une date de synchro réécrite se verrait.
    await new Promise((resolve) => setTimeout(resolve, 15));
    alterTpy(tpy, 'ALTER TABLE items RENAME TO items_abimee');
    const result = await tropyService.sync(noOcr);

    expect(result.success).toBe(false);
    expect(result.issues).toEqual([{ code: 'tropy-unreadable' }]);
    expect(result.errors).toEqual([expect.stringContaining('no such table: items')]);
    expect(brainState()).toEqual(before);

    // La base réparée, tout revient.
    alterTpy(tpy, 'ALTER TABLE items_abimee RENAME TO items');
    const repaired = await tropyService.sync(noOcr);
    expect(repaired.success).toBe(true);
    expect(repaired.issues).toEqual([]);
    expect(repaired.totalItems).toBe(3);
  });

  it('les photos de l’item du milieu illisibles : échec, ni les autres items ni ses photos ne sont réécrits', async () => {
    const tpy = writeTpy();
    await tropyService.init(projectDir);
    await tropyService.openProject(tpy);
    expect((await tropyService.sync(noOcr)).success).toBe(true);
    expect(photosOf(20)).toEqual([21]);

    // L'historien a retouché les trois items dans Tropy : une passe complète
    // les réécrirait tous.
    writeTpy(' (révisé)', '2026-06-01T08:00:00.000Z');
    const before = brainState();
    const broken = failRead(tpy, /FROM photos p[\s\S]*p\.item_id = \?/, 20);

    const result = await tropyService.sync(noOcr);
    broken.mockRestore();

    expect(result.success).toBe(false);
    expect(result.issues).toEqual([{ code: 'tropy-unreadable' }]);
    expect(result.newItems + result.updatedItems).toBe(0);
    expect(brainState()).toEqual(before);
    expect(photosOf(20)).toEqual([21]);

    // Témoin : la même passe, la page lisible, réécrit bien les trois items.
    const repaired = await tropyService.sync(noOcr);
    expect(repaired.success).toBe(true);
    expect(repaired.updatedItems).toBe(3);
    expect(photosOf(20)).toEqual([21]);
    expect(brainState().tropy_sources.some((row) => row.includes('Lettre du commissaire (révisé)'))).toBe(true);
  });
});

// MARK: - Avant TropyReader

/**
 * La garde d'identité (`assessTropyBinding`) lit le .tpy avant `TropyReader` :
 * un fichier tronqué, qui n'est pas une base, sans droit de lecture, ou dont
 * la table `project` est illisible, échoue là. L'erreur n'était pas typée, la
 * synchro échouait sans avis, et « Synchroniser » ne montrait rien.
 */
describe.skipIf(!sqliteAvailable)('TropySync : un .tpy illisible dès son ouverture se dit aussi (J6)', () => {
  /** Une synchro réussie, puis le .tpy abîmé par `damage` : la passe suivante, et brain.db avant elle. */
  async function syncAfterDamage(damage: (dbPath: string) => void, wal = false) {
    const tpy = writeTpy('', undefined, wal);
    await tropyService.init(projectDir);
    expect((await tropyService.openProject(tpy)).success).toBe(true);
    expect((await tropyService.sync(noOcr)).success).toBe(true);
    const before = brainState();
    expect(before.tropy_sources).toHaveLength(3);

    await new Promise((resolve) => setTimeout(resolve, 15));
    const dbPath = tpyDatabasePath(tpy);
    damage(dbPath);
    const result = await tropyService.sync(noOcr);
    return { result, before, dbPath };
  }

  const halve = (dbPath: string) => fs.truncateSync(dbPath, Math.floor(fs.statSync(dbPath).size / 2));

  it.each([
    ['tronqué de moitié', halve, false],
    ['tronqué de moitié, en journal WAL comme ceux de Tropy', halve, true],
    ['réduit à sa première page', (dbPath: string) => fs.truncateSync(dbPath, 4096), false],
    ['qui n’est pas une base SQLite', (dbPath: string) => fs.writeFileSync(dbPath, 'pas une base '.repeat(400)), false],
    ['dont la table project est illisible', (dbPath: string) => alterTpy(dbPath, 'ALTER TABLE project RENAME TO project_abime'), false],
    ['disparu (disque débranché, fichier déplacé)', (dbPath: string) => fs.unlinkSync(dbPath), false],
  ] as const)('un .tpy %s : échec, avis « projet Tropy illisible », brain.db inchangé', async (_label, damage, wal) => {
    const { result, before } = await syncAfterDamage(damage, wal);

    expect(result.success).toBe(false);
    expect(result.issues).toEqual([{ code: 'tropy-unreadable' }]);
    expect(result.errors).toEqual([expect.stringContaining('TropyReadError')]);
    expect(brainState()).toEqual(before);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'un .tpy sans droit de lecture (chmod 000) : échec, avis, brain.db inchangé ; les droits remis, tout revient',
    async () => {
      const { result, before, dbPath } = await syncAfterDamage((file) => fs.chmodSync(file, 0o000));
      try {
        expect(result.success).toBe(false);
        expect(result.issues).toEqual([{ code: 'tropy-unreadable' }]);
        expect(result.errors).toEqual([expect.stringContaining('EACCES')]);
        expect(brainState()).toEqual(before);
      } finally {
        fs.chmodSync(dbPath, 0o644);
      }

      const repaired = await tropyService.sync(noOcr);
      expect(repaired.success).toBe(true);
      expect(repaired.issues).toEqual([]);
    }
  );

  // Le remède que l'avis donne pour un projet déplacé : « Synchroniser »
  // relit l'ancien chemin et l'avis revient ; « Ouvrir un projet Tropy », au
  // nouvel emplacement, relie le même projet (même project_id) et l'avis s'en va.
  it('un .tpy lié déplacé : l’avis revient à chaque « Synchroniser » ; rouvert à son nouvel emplacement, il est relié, sources gardées', async () => {
    let moved = '';
    const { result, before } = await syncAfterDamage((dbPath) => {
      const target = path.join(root, 'Disque externe');
      fs.mkdirSync(target);
      moved = path.join(target, path.basename(dbPath));
      fs.renameSync(dbPath, moved);
    });
    expect(result.issues).toEqual([{ code: 'tropy-unreadable' }]);

    const again = await tropyService.sync(noOcr);
    expect(again.success).toBe(false);
    expect(again.issues).toEqual([{ code: 'tropy-unreadable' }]);
    expect(brainState()).toEqual(before);

    expect((await tropyService.openProject(moved)).success).toBe(true);
    const relinked = await tropyService.sync(noOcr);
    expect(relinked.success).toBe(true);
    expect(relinked.issues).toEqual([]);

    const after = brainState();
    expect(after.tropy_sources).toEqual(before.tropy_sources);
    expect(after.tropy_photos).toEqual(before.tropy_photos);
    expect(after.tropy_projects).toHaveLength(1);
    expect(JSON.parse(after.tropy_projects[0])).toMatchObject({ tpy_path: moved, project_uuid: 'tropy-greves' });
  });

  it('un .tpy devenu illisible entre la garde et l’ouverture par la synchro : échec, avis, brain.db inchangé', async () => {
    const { result, before } = await syncAfterDamage(() => {
      const denied = Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' });
      vi.spyOn(TropyReader.prototype, 'openProject').mockImplementationOnce(() => {
        throw denied;
      });
    });

    expect(result.success).toBe(false);
    expect(result.issues).toEqual([{ code: 'tropy-unreadable' }]);
    expect(result.errors).toEqual([expect.stringContaining('openProject')]);
    expect(brainState()).toEqual(before);
  });

  it('l’identité lue dans un .tpy illisible lève TropyReadError ; une panne de brain.db reste ce qu’elle est', () => {
    const tpy = writeTpy();
    const dbPath = tpyDatabasePath(tpy);
    fs.writeFileSync(dbPath, 'pas une base '.repeat(400));
    expect(thrown(() => readTropyProjectIdentity(tpy))).toMatchObject({
      name: 'TropyReadError',
      method: 'readTropyProjectIdentity',
      message: expect.stringContaining('file is not a database'),
    });

    // La garde lit aussi brain.db : son erreur n'est pas un .tpy illisible.
    const healthy = writeTpy();
    const brainDown = new Error('brain.db: database is locked');
    const store = {
      getTropyProject: () => {
        throw brainDown;
      },
      getStatistics: () => {
        throw new Error('non appelé');
      },
      getPhotoFingerprint: () => [],
    } satisfies Parameters<typeof assessTropyBinding>[1];
    expect(thrown(() => assessTropyBinding(healthy, store))).toBe(brainDown);
  });
});

// MARK: - Autres lecteurs

describe.skipIf(!sqliteAvailable)('les autres lecteurs reçoivent l’erreur (J6)', () => {
  it('photos d’une source pour l’OCR : un échec dit au renderer, pas « aucune image »', async () => {
    const tpy = writeTpy();
    await tropyService.init(projectDir);
    await tropyService.openProject(tpy);
    await tropyService.sync(noOcr);
    const source = tropyService.getAllSources().find((s) => s.tropyId === 20);
    expect(source).toBeDefined();
    const id = source?.id ?? '';

    expect(await invoke('tropy:get-source-photos', id)).toEqual({
      success: true,
      paths: [path.join(tropyDir, 'lettre.jpg')],
    });

    failRead(tpy, /FROM photos p[\s\S]*p\.item_id = \?/, 20);
    expect(thrown(() => tropyService.getSourcePhotoPaths(id))).toMatchObject({
      name: 'TropyReadError',
      method: 'getItemPhotos',
    });
    expect(await invoke('tropy:get-source-photos', id)).toEqual({
      success: false,
      error: expect.stringContaining('database disk image is malformed'),
    });
  });
});
