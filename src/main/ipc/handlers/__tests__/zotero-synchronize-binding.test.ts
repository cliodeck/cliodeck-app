/**
 * Une synchronisation Zotero confirmée vaut pour le projet qui l'a demandée, et pour le rapport
 * que l'auteur a lu (S07-1-0).
 *
 * Le second appel, celui de l'accord, n'était lié ni à l'un ni à l'autre : le main relisait le
 * projet courant au moment du clic, et `confirmed: true` appliquait tout ce que le diff recalculé
 * trouvait. Lancée dans A, confirmée après l'ouverture de B, la synchronisation réécrivait le
 * `.bib` de B avec la collection de A et en retirait toutes les entrées liées à Zotero.
 *
 * Vrai handler, vrai service, fichiers réels dans deux projets temporaires. Seuls sont simulés la
 * source Zotero (aucun appel à l'API, aucune base Zotero lue) et le projet courant du main, une
 * simple variable comme celle que pose `project:load`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IZoteroDataSource } from '../../../../../backend/integrations/zotero/IZoteroDataSource.js';
import type { ZoteroCollection, ZoteroItem } from '../../../../../backend/integrations/zotero/ZoteroAPI.js';
import type { SyncReport } from '../../../../../backend/integrations/zotero/ZoteroSynchronizer.js';
import { symlinkAvailable } from '../../../../../backend/__tests__/helpers/native-guards.js';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

/** Le projet ouvert dans le main. */
let current: string | null = null;
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => current },
}));

interface FakeStore {
  replaceCollections: ReturnType<typeof vi.fn>;
  replaceCollectionMemberships: ReturnType<typeof vi.fn>;
  linkDocumentsToCollectionsByBibtexKey: ReturnType<typeof vi.fn>;
}
const stores = new Map<string, FakeStore>();
vi.mock('../../../services/pdf-service.js', () => ({
  pdfService: { getVectorStore: () => (current ? stores.get(current) ?? null : null) },
}));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: { getAPIKey: () => '' },
}));
// Les notes de lecture ne sont pas en jeu : aucune clé n'est refaite ici.
vi.mock('../../../services/reading-notes-indexing.js', () => ({
  indexReadingNotesInBackground: () => undefined,
}));

const { setupZoteroHandlers } = await import('../zotero-handlers.js');
const { zoteroService } = await import('../../../services/zotero-service.js');
setupZoteroHandlers();

type Response = { success: boolean; status?: string; error?: string; report?: SyncReport };
const synchronize = (request: Record<string, unknown>) =>
  handlers.get('zotero:synchronize')?.({}, request) as Promise<Response>;

/** L'accord de l'auteur, donné sur le rapport qu'il a lu — ce que renvoie le renderer. */
const approve = (report: SyncReport) => ({ confirmation: report.confirmation });

// --- La bibliothèque Zotero simulée ---------------------------------------------------------

const notice = (key: string, title: string, lastName: string): ZoteroItem =>
  ({
    key,
    version: 0,
    library: { type: 'user', id: 1, name: '' },
    data: {
      key,
      version: 0,
      itemType: 'journalArticle',
      title,
      date: '2022',
      dateAdded: '2022-01-01',
      creators: [{ creatorType: 'author', lastName, firstName: 'A.' }],
    },
  }) as ZoteroItem;

const collection = (key: string): ZoteroCollection => ({ key, version: 0, data: { key, version: 0, name: key } });

let contents: Record<string, ZoteroItem[]> = {};
/** Chaque ouverture de la source Zotero. */
let openSource: ReturnType<typeof vi.fn>;
/** Retient la lecture de la collection : la phase 1, qui dure en mode API. */
let reading: Promise<void> | null = null;

function fakeSource(): IZoteroDataSource {
  return {
    listCollections: async () => Object.keys(contents).map(collection),
    listSubcollections: async () => [],
    getCollection: async (key: string) => collection(key),
    listItems: async (options?: { collectionKey?: string }) => {
      if (reading) await reading;
      return [...(contents[options?.collectionKey ?? ''] ?? [])];
    },
    getItem: async () => {
      throw new Error('inutile ici');
    },
    getItemChildren: async () => [],
    getItemAttachments: async () => [],
    getItemNotes: async () => [],
    hasAttachments: async () => false,
    downloadFile: async () => ({ filename: '', size: 0 }),
    testConnection: async () => true,
    getItemMetadata: () => ({ title: '', authors: '', year: '', type: '' }),
  };
}

// --- Deux projets sur le disque -------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-zotero-accord-'));
let projectA = '';
let projectB = '';

function makeProject(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, 'project.json'),
    JSON.stringify({ name, type: 'article', createdAt: '2026-01-01T00:00:00.000Z' }, null, 2)
  );
  stores.set(dir, {
    replaceCollections: vi.fn(),
    replaceCollectionMemberships: vi.fn(),
    linkDocumentsToCollectionsByBibtexKey: vi.fn(() => 0),
  });
  return dir;
}

/** Ce que le renderer envoie, construit dans le projet où l'on a cliqué. */
const requestFrom = (project: string, collectionKey: string) => ({
  mode: 'local',
  dataDirectory: '/zotero',
  collectionKey,
  expectedProjectPath: project,
});

/**
 * Tous les fichiers que la synchronisation peut écrire, à l'octet : `latin1` fait un caractère
 * par octet, et garde un écart lisible.
 */
function snapshot(project: string): Record<string, string> {
  const files = ['bibliography.bib', 'project.json', path.join('.cliodeck', 'bibliography-metadata.json')];
  return Object.fromEntries(
    files.map((f) => {
      const p = path.join(project, f);
      return [f, fs.existsSync(p) ? fs.readFileSync(p).toString('latin1') : '(absent)'];
    })
  );
}

const bibKeys = (project: string): string[] =>
  [...fs.readFileSync(path.join(project, 'bibliography.bib'), 'utf-8').matchAll(/zoterokey = \{(\w+)\}/g)].map(
    (m) => m[1]
  );

async function firstImport(project: string, collectionKey: string): Promise<void> {
  current = project;
  const result = await synchronize(requestFrom(project, collectionKey));
  expect(result).toMatchObject({ success: true, status: 'applied' });
}

beforeEach(async () => {
  stores.clear();
  projectA = makeProject(`A-${Math.random().toString(36).slice(2, 8)}`);
  projectB = makeProject(`B-${Math.random().toString(36).slice(2, 8)}`);
  contents = {
    CA: [notice('A1', 'Article A1', 'Alpha'), notice('A2', 'Article A2', 'Bravo')],
    CB: [notice('B1', 'Livre B1', 'Charlie'), notice('B2', 'Livre B2', 'Delta'), notice('B3', 'Livre B3', 'Echo')],
  };
  reading = null;
  openSource = vi.fn(fakeSource);
  // @ts-expect-error méthode privée remplacée par la source simulée
  vi.spyOn(zoteroService, 'createDataSource').mockImplementation(openSource);

  await firstImport(projectA, 'CA');
  await firstImport(projectB, 'CB');
  for (const store of stores.values()) store.replaceCollections.mockClear();
  current = projectA;
  openSource.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('zotero:synchronize — l’accord vaut pour un projet', () => {
  it('A passe à B pendant la phase 1 : l’accord donné ensuite est refusé, et B reste intact à l’octet', async () => {
    contents.CA = contents.CA.filter((n) => n.key !== 'A2');
    let release: () => void = () => undefined;
    reading = new Promise<void>((resolve) => {
      release = resolve;
    });

    const request = requestFrom(projectA, 'CA');
    const pending = synchronize(request);
    // L'historien ouvre B pendant la lecture de la collection.
    current = projectB;
    release();
    const asked = await pending;
    reading = null;

    expect(asked).toMatchObject({ success: true, status: 'needs-confirmation' });
    expect(asked.report?.deleted.map((d) => d.title)).toEqual(['Article A2']);

    const bBefore = snapshot(projectB);
    const aBefore = snapshot(projectA);
    const confirmed = await synchronize({ ...request, ...approve(asked.report as SyncReport) });

    expect(confirmed).toMatchObject({ success: false, error: 'project-changed' });
    expect(snapshot(projectB)).toEqual(bBefore);
    expect(bibKeys(projectB)).toEqual(['B1', 'B2', 'B3']);
    expect(snapshot(projectA)).toEqual(aBefore);
    expect(stores.get(projectB)?.replaceCollections).not.toHaveBeenCalled();
  });

  it('dès le premier appel : un projet attendu qui n’est pas l’ouvert ne lit rien', async () => {
    current = projectB;
    const bBefore = snapshot(projectB);

    const result = await synchronize(requestFrom(projectA, 'CA'));

    expect(result).toMatchObject({ success: false, error: 'project-changed' });
    expect(openSource).not.toHaveBeenCalled();
    expect(snapshot(projectB)).toEqual(bBefore);
  });

  it.skipIf(!symlinkAvailable)('témoin : le même dossier par un autre chemin est le même projet', async () => {
    // Le renderer et le main n'écrivent pas toujours le chemin pareil (lien, `/private/var`) :
    // un refus « projet changé » injustifié ferait abandonner une synchronisation légitime.
    const link = path.join(root, `lien-${path.basename(projectA)}`);
    fs.symlinkSync(projectA, link);
    contents.CA = contents.CA.filter((n) => n.key !== 'A2');

    const request = requestFrom(link, 'CA');
    const asked = await synchronize(request);
    const done = await synchronize({ ...request, ...approve(asked.report as SyncReport) });

    expect(done).toMatchObject({ success: true, status: 'applied' });
    expect(bibKeys(projectA)).toEqual(['A1']);
    fs.unlinkSync(link);
  });
});

describe('zotero:synchronize — l’accord vaut pour le rapport lu', () => {
  it('une notice retirée de Zotero pendant la lecture de la boîte : rien n’est écrit, un nouveau rapport revient', async () => {
    contents.CA = contents.CA.filter((n) => n.key !== 'A2');
    const request = requestFrom(projectA, 'CA');
    const asked = await synchronize(request);
    expect(asked.report?.deleted.map((d) => d.title)).toEqual(['Article A2']);

    contents.CA = [];
    const aBefore = snapshot(projectA);
    const again = await synchronize({ ...request, ...approve(asked.report as SyncReport) });

    expect(again).toMatchObject({ success: true, status: 'needs-confirmation' });
    expect(again.report?.deleted.map((d) => d.title)).toEqual(expect.arrayContaining(['Article A1', 'Article A2']));
    expect(snapshot(projectA)).toEqual(aBefore);
  });

  it('témoin : le rapport lu et accepté s’applique, la notice sort du .bib', async () => {
    contents.CA = contents.CA.filter((n) => n.key !== 'A2');
    const request = requestFrom(projectA, 'CA');
    const asked = await synchronize(request);

    const done = await synchronize({ ...request, ...approve(asked.report as SyncReport) });

    expect(done).toMatchObject({ success: true, status: 'applied' });
    expect(bibKeys(projectA)).toEqual(['A1']);
    expect(bibKeys(projectB)).toEqual(['B1', 'B2', 'B3']);
  });
});
