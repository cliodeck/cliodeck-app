/**
 * `pdf:index`, `bibliography:update-attachment` et `zotero:download-pdf` refusent un autre projet
 * que le projet ouvert (S18-2-0).
 *
 * Un lot lancé dans A continuait après l'ouverture de B : `pdf:index` indexait les PDF de A dans
 * le corpus du projet courant, les métadonnées s'écrivaient au chemin que le renderer donnait, et
 * `download-pdf` téléchargeait dans `<targetDirectory>/PDFs` sans le confronter au projet. Le
 * renderer s'arrête désormais de lui-même ; le main refuse en plus ce qui partirait quand même
 * (l'ouverture de B, que le main prend avant l'écran).
 *
 * Vrais handlers, vrai `BibliographyMetadataService` et vrai `zoteroService` sur deux projets
 * temporaires. Sont simulés le projet courant du main (une variable, comme celle que pose
 * `project:load`), l'indexation (un compteur d'appels) et la source Zotero (aucun appel à l'API,
 * aucune base Zotero lue : le téléchargement écrit un faux PDF).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IZoteroDataSource } from '../../../../../backend/integrations/zotero/IZoteroDataSource.js';
import { symlinkAvailable } from '../../../../../backend/__tests__/helpers/native-guards.js';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  BrowserWindow: { fromWebContents: () => null },
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

/** Chaque indexation demandée au service : le fichier et le projet courant à ce moment. */
const indexPDF = vi.fn(async (filePath: string) => ({
  id: `doc-${path.basename(filePath)}`,
  title: path.basename(filePath),
  pageCount: 1,
  metadata: {},
}));
vi.mock('../../../services/pdf-service.js', () => ({
  pdfService: { indexPDF, getVectorStore: () => null },
}));
vi.mock('../../../services/history-service.js', () => ({
  historyService: { getHistoryManager: () => null },
}));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: { getAPIKey: () => '' },
}));
vi.mock('../../../services/reading-notes-indexing.js', () => ({
  indexReadingNotesInBackground: () => undefined,
}));

const { setupPDFHandlers } = await import('../pdf-handlers.js');
const { setupBibliographyHandlers } = await import('../bibliography-handlers.js');
const { setupZoteroHandlers } = await import('../zotero-handlers.js');
const { zoteroService } = await import('../../../services/zotero-service.js');
const { BibliographyMetadataService } = await import('../../../../../backend/services/BibliographyMetadataService.js');
setupPDFHandlers();
setupBibliographyHandlers();
setupZoteroHandlers();

type Response = { success: boolean; error?: string; filePath?: string };
const call = (channel: string, ...args: unknown[]) =>
  handlers.get(channel)?.({ sender: {} }, ...args) as Promise<Response>;

// --- Deux projets sur le disque -------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-garde-projet-'));
let A = '';
let B = '';

function makeProject(name: string): string {
  const dir = path.join(root, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name, type: 'article' }));
  return dir;
}

const metadataOf = (project: string) => BibliographyMetadataService.getMetadataPath(project);
const bytes = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file).toString('latin1') : '(absent)');
const pdfsOf = (project: string) =>
  fs.existsSync(path.join(project, 'PDFs')) ? fs.readdirSync(path.join(project, 'PDFs')) : [];

/** Les métadonnées de A : a0 téléchargée lors d'une session antérieure. */
async function seedMetadata(project: string): Promise<void> {
  await BibliographyMetadataService.saveFromSync(project, [
    {
      id: 'a0',
      zoteroKey: 'ZA0',
      zoteroAttachments: [
        { key: 'ATTA0', filename: 'a0.pdf', contentType: 'application/pdf', downloaded: true, localPath: path.join(project, 'PDFs', 'a0.pdf') },
      ],
    },
  ] as never);
}

let openSource: ReturnType<typeof vi.fn>;
function fakeSource(): IZoteroDataSource {
  return {
    downloadFile: async (_key: string, savePath: string) => {
      fs.writeFileSync(savePath, '%PDF-1.4 simulé');
      return { filename: path.basename(savePath), size: 15 };
    },
  } as unknown as IZoteroDataSource;
}

const download = (targetDirectory: string) =>
  call('zotero:download-pdf', {
    mode: 'local',
    dataDirectory: '/zotero-simule',
    attachmentKey: 'ATTA1',
    filename: 'a1.pdf',
    targetDirectory,
  });

const save = (projectPath: string) =>
  call('bibliography:update-attachment', {
    projectPath,
    citation: {
      id: 'b1',
      zoteroKey: 'ZB1',
      zoteroAttachments: [{ key: 'ATTB1', filename: 'b1.pdf', contentType: 'application/pdf', downloaded: false }],
    },
    attachmentKey: 'ATTB1',
    localPath: path.join(projectPath, 'PDFs', 'b1.pdf'),
  });

beforeEach(async () => {
  A = makeProject('A');
  B = makeProject('B');
  await seedMetadata(A);
  current = B;
  indexPDF.mockClear();
  openSource = vi.fn(fakeSource);
  // @ts-expect-error méthode privée remplacée par la source simulée
  vi.spyOn(zoteroService, 'createDataSource').mockImplementation(openSource);
  // @ts-expect-error méthode privée : rien à fermer pour la source simulée
  vi.spyOn(zoteroService, 'closeDataSource').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pdf:index — le projet attendu', () => {
  it('B ouvert, un PDF de A attendu dans A : refusé, rien n’est indexé', async () => {
    const result = await call('pdf:index', path.join(A, 'PDFs', 'a1.pdf'), 'a1', { title: 'A1' }, A);

    expect(indexPDF).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, error: 'project-changed' });
  });

  it('témoin : le projet attendu est l’ouvert, le PDF est indexé', async () => {
    current = A;
    const result = await call('pdf:index', path.join(A, 'PDFs', 'a1.pdf'), 'a1', { title: 'A1' }, A);

    expect(result.success).toBe(true);
    expect(indexPDF).toHaveBeenCalledTimes(1);
  });

  it('témoin : sans projet attendu (panneau d’indexation, gestes immédiats), rien ne change', async () => {
    const result = await call('pdf:index', path.join(B, 'PDFs', 'b1.pdf'), 'b1');

    expect(result.success).toBe(true);
    expect(indexPDF).toHaveBeenCalledTimes(1);
  });

  it.skipIf(!symlinkAvailable)('témoin : le même dossier par un autre chemin est le même projet', async () => {
    current = A;
    const link = path.join(root, `lien-${path.basename(A)}`);
    fs.symlinkSync(A, link);

    const result = await call('pdf:index', path.join(A, 'PDFs', 'a1.pdf'), 'a1', undefined, link);

    expect(result.success).toBe(true);
    expect(indexPDF).toHaveBeenCalledTimes(1);
    fs.unlinkSync(link);
  });
});

describe('bibliography:update-attachment — le projet ouvert seulement', () => {
  it('B ouvert : les métadonnées de A ne reçoivent pas le rattachement de B', async () => {
    const before = bytes(metadataOf(A));

    const result = await save(A);

    expect(bytes(metadataOf(A))).toBe(before);
    expect(result).toMatchObject({ success: false, error: 'project-changed' });
  });

  it('aucun projet ouvert : rien n’est écrit', async () => {
    current = null;
    const before = bytes(metadataOf(A));

    const result = await save(A);

    expect(bytes(metadataOf(A))).toBe(before);
    expect(result.success).toBe(false);
  });

  it('témoin : dans le projet ouvert, le rattachement est écrit, à côté de ceux d’avant', async () => {
    current = A;

    const result = await save(A);

    expect(result.success).toBe(true);
    const citations = JSON.parse(fs.readFileSync(metadataOf(A), 'utf-8')).citations;
    expect(Object.keys(citations)).toEqual(['ZA0', 'ZB1']);
    // Rangés relatifs au projet (S07-2-1).
    expect(citations.ZA0.zoteroAttachments[0]).toMatchObject({ downloaded: true, localPath: 'PDFs/a0.pdf' });
    expect(citations.ZB1.zoteroAttachments[0]).toMatchObject({ downloaded: true, localPath: 'PDFs/b1.pdf' });
  });

  it('métadonnées illisibles : refusé avec son code, et rien n’est écrit', async () => {
    current = A;
    fs.writeFileSync(metadataOf(A), '{"version": 2, "citat');

    const result = (await save(A)) as Response & { code?: string };

    expect(result).toMatchObject({ success: false, code: 'metadata-unreadable' });
    expect(bytes(metadataOf(A))).toBe('{"version": 2, "citat');
  });

  it.skipIf(!symlinkAvailable)('témoin : le projet ouvert désigné par un lien est accepté', async () => {
    current = A;
    const link = path.join(root, `lien-meta-${path.basename(A)}`);
    fs.symlinkSync(A, link);

    const result = await save(link);

    expect(result.success).toBe(true);
    fs.unlinkSync(link);
  });
});

describe('zotero:download-pdf — dans le projet ouvert seulement', () => {
  it('B ouvert : rien n’est téléchargé dans A/PDFs', async () => {
    const result = await download(A);

    expect(pdfsOf(A)).toEqual([]);
    expect(openSource).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, error: 'project-changed' });
  });

  it('aucun projet ouvert : rien n’est téléchargé', async () => {
    current = null;

    const result = await download(A);

    expect(pdfsOf(A)).toEqual([]);
    expect(result.success).toBe(false);
  });

  it('témoin : dans le projet ouvert, le PDF arrive dans PDFs', async () => {
    current = A;

    const result = await download(A);

    expect(result).toMatchObject({ success: true, filePath: path.join(A, 'PDFs', 'a1.pdf') });
    expect(pdfsOf(A)).toEqual(['a1.pdf']);
  });

  it.skipIf(!symlinkAvailable)('témoin : le projet ouvert désigné par un lien est accepté', async () => {
    current = A;
    const link = path.join(root, `lien-pdf-${path.basename(A)}`);
    fs.symlinkSync(A, link);

    const result = await download(link);

    expect(result.success).toBe(true);
    expect(pdfsOf(A)).toEqual(['a1.pdf']);
    fs.unlinkSync(link);
  });
});
