/**
 * La synchronisation Zotero garde ce que le `.bib` porte hors de ses entrées (H2) : en-tête,
 * `@comment`, `@preamble`, texte libre.
 *
 * Elle réécrit le fichier depuis ses citations, et l'exporteur n'écrit que des entrées : les
 * groupes de BibDesk (`@comment{BibDesk Static Groups{…}}`) et de JabRef
 * (`@Comment{jabref-meta: grouping:…}`), leurs réglages et les commentaires de l'historien
 * disparaissaient à la première synchronisation qui écrivait. La copie `.bak` ne les gardait que
 * jusqu'à l'écriture suivante.
 *
 * Vrai handler, vrai service, fichiers réels dans un projet temporaire. Seuls sont simulés la
 * source Zotero (aucun appel à l'API, aucune base Zotero lue) et le projet courant du main.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { IZoteroDataSource } from '../../../../backend/integrations/zotero/IZoteroDataSource.js';
import type { ZoteroCollection, ZoteroItem } from '../../../../backend/integrations/zotero/ZoteroAPI.js';
import { BibTeXParser } from '../../../../backend/core/bibliography/BibTeXParser.js';
import { BibTeXExporter } from '../../../../backend/core/bibliography/BibTeXExporter.js';
import { auditParsedBib } from '../../../../backend/core/bibliography/bibAudit.js';

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

type Response = { success: boolean; status?: string; error?: string; written?: boolean };
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

const FIXTURES = fileURLToPath(new URL('../../../../backend/core/bibliography/__tests__/fixtures/', import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, `${name}.bib`), 'utf-8');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-zotero-blocs-'));
let project = '';
const BIB = 'ma-biblio.bib';
const bibPath = () => path.join(project, BIB);
const backupPath = () => path.join(project, '.cliodeck', 'bibliography.bib.bak');

function makeProject(bib: string): void {
  project = path.join(root, `p-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(project, '.cliodeck'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'project.json'),
    JSON.stringify(
      { name: 'Thèse', type: 'article', createdAt: '2026-01-01T00:00:00.000Z', bibliographySource: { type: 'file', filePath: BIB } },
      null,
      2
    )
  );
  fs.writeFileSync(bibPath(), bib);
  current = project;
}

const request = () => ({ mode: 'local', dataDirectory: '/zotero', collectionKey: 'COLL', expectedProjectPath: project });

beforeEach(() => {
  contents = { COLL: [notice('MART2021', 'Les archives orales', 'Martin')] };
  // @ts-expect-error méthode privée remplacée par la source simulée
  vi.spyOn(zoteroService, 'createDataSource').mockImplementation(fakeSource);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// --- Ce que chaque fixture porte hors de ses entrées ----------------------------------------

/**
 * `head` : le texte avant la première entrée, qui reste en tête. `after` : ce qui va après les
 * entrées, dans l'ordre d'origine — ce qui suivait la dernière, ce qui séparait deux entrées.
 * Chaque morceau est copié du fichier d'origine, à l'octet.
 */
interface Case {
  name: string;
  ids: string[];
  head: (bib: string) => string;
  after: (bib: string) => string[];
}

const from = (bib: string, start: string, end?: string) => {
  const i = bib.indexOf(start);
  if (i === -1) throw new Error(`« ${start} » absent de la fixture`);
  return end === undefined ? bib.slice(i).trimEnd() : bib.slice(i, bib.indexOf(end, i) + end.length);
};

const CASES: Case[] = [
  {
    name: 'blocs-bibdesk',
    ids: ['Garde2000', 'Leduc1990'],
    head: (bib) => bib.slice(0, bib.indexOf('@book{Garde2000,')).trimEnd(),
    after: (bib) => [from(bib, '@comment{BibDesk Static Groups{')],
  },
  {
    name: 'blocs-jabref',
    ids: ['Dupont2010', 'Garde2000'],
    head: (bib) => bib.slice(0, bib.indexOf('@Article{Dupont2010,')).trimEnd(),
    after: (bib) => [from(bib, '@Comment{jabref-meta: databaseType:biblatex;}')],
  },
  {
    name: 'blocs-preambule',
    ids: ['Garde2000', 'Leduc1990'],
    head: (bib) => bib.slice(0, bib.indexOf('@book{Garde2000,')).trimEnd(),
    after: (bib) => [
      from(bib, '% --- Sources imprimées ---', 'fonds AN F7.'),
      from(bib, '@comment(à revoir'),
    ],
  },
];

/** Les blocs `@comment` et `@preamble` du fichier, chacun en entier. */
function blocksOf(bib: string): string[] {
  return [...bib.matchAll(/@(?:comment|preamble)\s*[{(]/gi)].map((match) => {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < bib.length; i++) {
      if (bib[i] === '{' || bib[i] === '(') depth++;
      if (bib[i] === '}' || bib[i] === ')') depth--;
      if (depth === 0) return bib.slice(match.index, i + 1);
    }
    throw new Error('bloc non refermé dans la fixture');
  });
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;
const parse = (bib: string) => new BibTeXParser().parse(bib);

/**
 * Le `.bib` écrit garde, à l'octet et une seule fois, l'en-tête en tête et les blocs d'après en
 * fin ; ses entrées se relisent toutes, sans entrée non lue.
 */
function expectKept(original: string, written: string, c: Case, ids: string[]): void {
  const head = c.head(original);
  expect(written.startsWith(head), 'l’en-tête reste en tête').toBe(true);
  expect(occurrences(written, head)).toBe(1);

  const citations = parse(written);
  expect(citations.map((citation) => citation.id).sort()).toEqual([...ids].sort());
  expect(auditParsedBib(written, citations).unreadKeys).toEqual([]);

  const lastEntry = Math.max(...ids.map((id) => written.indexOf(`{${id},`)));
  let previous = lastEntry;
  for (const part of c.after(original)) {
    expect(occurrences(written, part), part.slice(0, 40)).toBe(1);
    const at = written.indexOf(part);
    expect(at, `${part.slice(0, 40)} : après les entrées, dans l’ordre d’origine`).toBeGreaterThan(previous);
    previous = at;
  }
  for (const block of blocksOf(original)) expect(occurrences(written, block), block.slice(0, 40)).toBe(1);
}

describe.each(CASES)('zotero:synchronize — $name : ce qui n’est pas une entrée reste', (c) => {
  it('une synchronisation qui ajoute une référence garde chaque bloc, à sa place, une seule fois', async () => {
    const original = fixture(c.name);
    makeProject(original);

    expect(await synchronize(request())).toMatchObject({ success: true, status: 'applied', written: true });

    const written = fs.readFileSync(bibPath(), 'utf-8');
    expectKept(original, written, c, [...c.ids, 'Martin_2021']);
    // La copie de sécurité reste l'état d'avant, à l'octet.
    expect(fs.readFileSync(backupPath(), 'utf-8')).toBe(original);
  });

  it('deux synchronisations qui écrivent : toujours un seul exemplaire de chaque bloc', async () => {
    const original = fixture(c.name);
    makeProject(original);

    expect(await synchronize(request())).toMatchObject({ success: true, written: true });
    contents.COLL.push(notice('LEDU2022', 'Les carnets retrouvés', 'Leblanc'));
    expect(await synchronize(request())).toMatchObject({ success: true, written: true });

    expectKept(original, fs.readFileSync(bibPath(), 'utf-8'), c, [...c.ids, 'Martin_2021', 'Leblanc_2021']);
    // Rien de nouveau : pas de réécriture, le fichier reste tel quel.
    const settled = fs.readFileSync(bibPath());
    expect(await synchronize(request())).toMatchObject({ success: true, written: false });
    expect(fs.readFileSync(bibPath()).equals(settled)).toBe(true);
  });
});

/**
 * Une arobase hors des entrées : le parseur collait au type de l'entrée qui suit ce qui allait de
 * l'arobase à l'accolade de l'entrée, et la réécriture l'écrivait avec l'entrée. Repris aussi en
 * fin de fichier, ce texte s'y ajoutait à chaque synchronisation qui écrivait (H2). Depuis J2, ce
 * texte est hors des entrées, repris entier comme le reste.
 */
describe('zotero:synchronize — une arobase hors des entrées', () => {
  const ENTRIES = [
    '@book{Garde2000,',
    '  title = {Le temps des archives},',
    '  year = {2000},',
    '}',
    '',
    '% voir aussi @Garde2000 pour le contexte',
    '@article{Leduc1990,',
    '  title = {Le carnet},',
    '  year = {1990},',
    '}',
    '',
  ].join('\n');
  const JABREF = '@Comment{jabref-meta: databaseType:biblatex;}';
  const GROUPS = '@comment{BibDesk Static Groups{\n<plist version="1.0"><array></array></plist>\n}}';

  async function synchronizeThrice(): Promise<string[]> {
    const written: string[] = [];
    for (const added of [null, notice('LEDU2022', 'Les carnets retrouvés', 'Leblanc'), notice('NEUF2023', 'Un troisième', 'Neuf')]) {
      if (added) contents.COLL.push(added);
      expect(await synchronize(request())).toMatchObject({ success: true, written: true });
      written.push(fs.readFileSync(bibPath(), 'utf-8'));
    }
    return written;
  }

  it('dans un commentaire % entre deux entrées : trois synchronisations qui écrivent, rien ne s’ajoute en fin de fichier', async () => {
    makeProject(`% Bibliographie de la thèse\n\n${ENTRIES}\n${JABREF}\n`);

    const [first, , last] = await synchronizeThrice();

    expect(occurrences(last, '@Garde2000 pour le contexte')).toBe(1);
    expect(occurrences(last, '% voir aussi')).toBe(1);
    expect(occurrences(last, JABREF)).toBe(1);
    // Ce qui suit la dernière entrée ne change pas d'une synchronisation à l'autre.
    expect(last.slice(last.indexOf('% voir aussi'))).toBe(first.slice(first.indexOf('% voir aussi')));
    const citations = parse(last);
    expect(citations.map((citation) => citation.id).sort()).toEqual(['Garde2000', 'Leblanc_2021', 'Leduc1990', 'Martin_2021', 'Neuf_2021']);
    expect(auditParsedBib(last, citations).unreadKeys).toEqual([]);
  });

  it('une adresse dans l’en-tête, des groupes BibDesk en fin : l’en-tête, entier, et les groupes restent', async () => {
    makeProject(`%% Tenu par jean.dupont@univ-paris.example\n\n${ENTRIES}\n${GROUPS}\n`);

    const written = await synchronizeThrice();

    for (const bib of written) {
      expect(bib.startsWith('%% Tenu par jean.dupont@univ-paris.example\n\n@book{Garde2000,\n')).toBe(true);
      expect(occurrences(bib, GROUPS)).toBe(1);
      expect(bib.endsWith(`${GROUPS}\n`)).toBe(true);
    }
    expect(written[2].slice(written[2].indexOf('% voir aussi'))).toBe(written[0].slice(written[0].indexOf('% voir aussi')));
  });
});

describe('zotero:synchronize — témoin', () => {
  // Rien hors des entrées que des lignes vides : le fichier écrit est celui de l'exporteur, sans
  // un octet de plus, comme avant.
  it('un .bib sans rien hors de ses entrées est réécrit comme avant', async () => {
    makeProject(
      ['', '@book{Garde_2000,', '  title = {Le temps des archives},', '  year = {2000},', '}', '', '', '@misc{Main_2010,', '  title = {Une note},', '}', ''].join('\n')
    );

    expect(await synchronize(request())).toMatchObject({ success: true, written: true });

    const written = fs.readFileSync(bibPath(), 'utf-8');
    expect(parse(written).map((citation) => citation.id)).toEqual(['Garde_2000', 'Main_2010', 'Martin_2021']);
    expect(written).toBe(new BibTeXExporter().exportToString(parse(written)));
  });
});
