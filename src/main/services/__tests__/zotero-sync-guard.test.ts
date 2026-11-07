/**
 * Un `.bib` ou des métadonnées mal lus ne sont jamais réécrits par la synchronisation Zotero
 * (S07-1-2, S07-1-10).
 *
 * La synchronisation relit le `.bib` du projet, puis le réécrit à partir des seules entrées que le
 * parseur a rendues. Une entrée saisie à la main sans titre, une accolade qui ne se ferme pas, une
 * définition `@string` disparaissaient du fichier sans un mot, et le bilan affirmait que les
 * références locales avaient été « conservées telles quelles ». Des métadonnées illisibles
 * passaient pour absentes, et leur réécriture effaçait tous les rattachements de PDF.
 *
 * Vrai handler, vrai service, fichiers réels dans un projet temporaire. Seuls sont simulés la
 * source Zotero (aucun appel à l'API, aucune base Zotero lue) et le projet courant du main.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IZoteroDataSource } from '../../../../backend/integrations/zotero/IZoteroDataSource.js';
import type { ZoteroCollection, ZoteroItem } from '../../../../backend/integrations/zotero/ZoteroAPI.js';
import type { SyncReport } from '../../../../backend/integrations/zotero/ZoteroSynchronizer.js';

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
vi.mock('../project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => current },
}));
vi.mock('../pdf-service.js', () => ({ pdfService: { getVectorStore: () => null } }));
vi.mock('../config-manager.js', () => ({ configManager: { getAPIKey: () => '' } }));
vi.mock('../reading-notes-indexing.js', () => ({ indexReadingNotesInBackground: () => undefined }));

const { setupZoteroHandlers } = await import('../../ipc/handlers/zotero-handlers.js');
const { zoteroService } = await import('../zotero-service.js');
setupZoteroHandlers();

type Response = {
  success: boolean;
  status?: string;
  error?: string;
  report?: SyncReport;
  file?: string;
  unreadKeys?: string[];
  hasStringMacros?: boolean;
  reason?: string;
};
const synchronize = (request: Record<string, unknown>) =>
  handlers.get('zotero:synchronize')?.({}, request) as Promise<Response>;

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
      date: '2021',
      dateAdded: '2021-01-01',
      creators: [{ creatorType: 'author', lastName, firstName: 'A.' }],
    },
  }) as ZoteroItem;

const collection = (key: string): ZoteroCollection => ({ key, version: 0, data: { key, version: 0, name: key } });

let contents: Record<string, ZoteroItem[]> = {};
let openSource: ReturnType<typeof vi.fn>;

function fakeSource(): IZoteroDataSource {
  return {
    listCollections: async () => Object.keys(contents).map(collection),
    listSubcollections: async () => [],
    getCollection: async (key: string) => collection(key),
    listItems: async (options?: { collectionKey?: string }) => [...(contents[options?.collectionKey ?? ''] ?? [])],
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

// --- Le projet sur le disque ----------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-zotero-garde-'));
let project = '';
const BIB = 'ma-biblio.bib';
const bibPath = () => path.join(project, BIB);
const backupPath = () => path.join(project, '.cliodeck', 'bibliography.bib.bak');
const metadataPath = () => path.join(project, '.cliodeck', 'bibliography-metadata.json');

/** Le projet que laisse un import de `.bib` : `bibliographySource` de type fichier. */
function makeProject(bib: string | Buffer): void {
  project = path.join(root, `p-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(project, '.cliodeck'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'project.json'),
    JSON.stringify(
      {
        name: 'Thèse',
        type: 'article',
        createdAt: '2026-01-01T00:00:00.000Z',
        bibliographySource: { type: 'file', filePath: BIB },
      },
      null,
      2
    )
  );
  fs.writeFileSync(bibPath(), bib);
  current = project;
}

const request = () => ({ mode: 'local', dataDirectory: '/zotero', collectionKey: 'COLL', expectedProjectPath: project });

/** Les octets des fichiers que la synchronisation peut écrire. */
function snapshot(): Record<string, string> {
  const files = [BIB, 'project.json', path.join('.cliodeck', 'bibliography-metadata.json'), path.join('.cliodeck', 'bibliography.bib.bak')];
  return Object.fromEntries(
    files.map((f) => {
      const p = path.join(project, f);
      return [f, fs.existsSync(p) ? fs.readFileSync(p).toString('base64') : '(absent)'];
    })
  );
}

const GARDE = ['@book{Garde_2000,', '  author = {Garde, Paul},', '  title = {Le temps des archives},', '  year = {2000},', '}'].join('\n');

beforeEach(() => {
  contents = { COLL: [notice('MART2021', 'Les archives orales', 'Martin')] };
  openSource = vi.fn(fakeSource);
  // @ts-expect-error méthode privée remplacée par la source simulée
  vi.spyOn(zoteroService, 'createDataSource').mockImplementation(openSource);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** La synchronisation refusée : rien n'est écrit, pas même la copie de sécurité, et Zotero n'est pas lu. */
async function expectRefused(expected: Partial<Response>): Promise<Response> {
  const before = snapshot();
  const result = await synchronize(request());

  expect(result).toMatchObject({ success: false, ...expected });
  expect(snapshot()).toEqual(before);
  expect(fs.existsSync(backupPath())).toBe(false);
  expect(openSource).not.toHaveBeenCalled();
  return result;
}

describe('zotero:synchronize — une entrée que le parseur n’a pas lue arrête tout', () => {
  it('une entrée sans titre : refus nommant la clé, .bib identique à l’octet', async () => {
    makeProject(['@misc{entretien_dupont,', '  author = {Dupont, Jean},', '  note = {Entretien},', '  year = {1998},', '}', GARDE, ''].join('\n'));

    await expectRefused({ error: 'bib-unread', file: BIB, unreadKeys: ['entretien_dupont'], hasStringMacros: false });
  });

  it('un titre vide', async () => {
    makeProject(['@misc{carton_AN_F7_1234,', '  title = {},', '}', GARDE, ''].join('\n'));

    await expectRefused({ error: 'bib-unread', unreadKeys: ['carton_AN_F7_1234'] });
  });

  it('une accolade qui ne se ferme pas', async () => {
    makeProject(['@book{Lefort_1999,', '  title = {Le {travail de l’histoire},', '  year = {1999},', '}', '', GARDE, ''].join('\n'));

    await expectRefused({ error: 'bib-unread', unreadKeys: ['Lefort_1999'] });
  });

  it('une définition @string, que la réécriture perdrait', async () => {
    makeProject(['@string{AN = "Archives nationales"}', '', '@book{Garde_2000,', '  title = {Le temps des archives},', '  publisher = AN,', '}', ''].join('\n'));

    await expectRefused({ error: 'bib-unread', unreadKeys: [], hasStringMacros: true });
  });

  it('un .bib qui n’est pas en UTF-8 est refusé, pas relu avec des caractères de remplacement', async () => {
    makeProject(Buffer.from(['@book{Garde_2000,', '  title = {Les archives de l’État},', '}', ''].join('\n'), 'latin1'));

    await expectRefused({ error: 'bib-unreadable', file: BIB, reason: 'encoding' });
  });

  it('le .bib abîmé entre la question et l’accord : le second appel est refusé aussi', async () => {
    makeProject(GARDE + '\n');
    // Une notice déjà liée, retirée de la collection : la synchronisation demandera l'accord.
    contents = { COLL: [notice('MART2021', 'Les archives orales', 'Martin'), notice('LEDU1990', 'Le carnet', 'Leduc')] };
    expect(await synchronize(request())).toMatchObject({ success: true, status: 'applied' });
    contents.COLL = contents.COLL.filter((n) => n.key !== 'LEDU1990');
    const asked = await synchronize(request());
    expect(asked).toMatchObject({ success: true, status: 'needs-confirmation' });

    // Entre-temps, l'historien ajoute à la main une entrée sans titre.
    fs.appendFileSync(bibPath(), '\n@misc{entretien_dupont,\n  note = {Entretien},\n}\n');
    const before = snapshot();
    openSource.mockClear();
    const confirmed = await synchronize({ ...request(), confirmation: asked.report?.confirmation });

    expect(confirmed).toMatchObject({ success: false, error: 'bib-unread', unreadKeys: ['entretien_dupont'] });
    expect(snapshot()).toEqual(before);
    expect(openSource).not.toHaveBeenCalled();
  });
});

describe('zotero:synchronize — des métadonnées illisibles arrêtent tout', () => {
  const RATTACHEMENTS = JSON.stringify({ version: 2, lastUpdated: 'x', citations: { MART2021: { id: 'Martin_2021' } } });

  it('JSON tronqué : refus, métadonnées et .bib inchangés', async () => {
    makeProject(GARDE + '\n');
    fs.writeFileSync(metadataPath(), RATTACHEMENTS.slice(0, 40));

    await expectRefused({ error: 'metadata-unreadable', file: path.join('.cliodeck', 'bibliography-metadata.json') });
  });

  it('même sans .bib encore écrit : les métadonnées ne sont pas remplacées', async () => {
    makeProject('');
    fs.rmSync(bibPath());
    fs.writeFileSync(metadataPath(), RATTACHEMENTS.slice(0, 40));

    await expectRefused({ error: 'metadata-unreadable' });
  });
});

describe('zotero:synchronize — un refus dit « rien n’a été écrit » seulement avant l’écriture', () => {
  it('project.json qui n’est pas un manifeste, relevé après l’écriture du .bib : un échec, pas un refus du .bib', async () => {
    makeProject(GARDE + '\n');
    // Un tableau se lit au début (pas d'objet, donc .bib par défaut), et se refuse à la fin.
    fs.writeFileSync(path.join(project, 'project.json'), '[]');
    fs.writeFileSync(path.join(project, 'bibliography.bib'), GARDE + '\n');

    const result = await synchronize(request());

    expect(result.success).toBe(false);
    expect(result.error).not.toBe('bib-unreadable');
    expect(fs.readFileSync(path.join(project, 'bibliography.bib'), 'utf-8')).toContain('Martin');
  });
});

describe('zotero:synchronize — la copie de sécurité', () => {
  it('témoin : un .bib sain se réécrit, et la copie garde l’état d’avant à l’octet', async () => {
    const before = GARDE + '\n\n% saisi à la main\n';
    makeProject(before);

    const result = await synchronize(request());

    expect(result).toMatchObject({ success: true, status: 'applied', written: true });
    expect(fs.readFileSync(bibPath(), 'utf-8')).toContain('Martin');
    expect(fs.readFileSync(bibPath(), 'utf-8')).toContain('Garde_2000');
    expect(fs.readFileSync(backupPath(), 'utf-8')).toBe(before);
  });

  it('la copie ne remonte qu’à la dernière réécriture', async () => {
    makeProject(GARDE + '\n');
    await synchronize(request());
    const afterFirst = fs.readFileSync(bibPath());
    contents.COLL.push(notice('LEDU1990', 'Le carnet', 'Leduc'));

    await synchronize(request());

    expect(fs.readFileSync(backupPath()).equals(afterFirst)).toBe(true);
  });

  it('rien à écrire : pas de copie', async () => {
    makeProject(GARDE + '\n');
    contents = { COLL: [] };

    const result = await synchronize(request());

    expect(result).toMatchObject({ success: true, status: 'applied', written: false });
    expect(fs.existsSync(backupPath())).toBe(false);
  });

  it('une copie qui échoue arrête l’écriture : le .bib reste intact', async () => {
    makeProject(GARDE + '\n');
    // Un dossier à la place de la copie : elle ne peut pas s'écrire.
    fs.mkdirSync(backupPath());
    const before = fs.readFileSync(bibPath());

    const result = await synchronize(request());

    expect(result.success).toBe(false);
    expect(fs.readFileSync(bibPath()).equals(before)).toBe(true);
    expect(fs.existsSync(metadataPath())).toBe(false);
  });
});
