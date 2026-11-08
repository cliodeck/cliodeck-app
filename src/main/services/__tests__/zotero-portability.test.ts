/**
 * Un projet renommé, ou ouvert sur un autre Mac, garde ses PDF Zotero (S07-2-1).
 *
 * Le chemin d'un PDF téléchargé s'écrivait en absolu dans `bibliography-metadata.json` et, à la
 * synchronisation suivante, dans le champ `file` du `.bib`. Le dossier du projet renommé dans le
 * Finder (ou synchronisé par Dropbox sous un autre nom d'utilisateur), chaque fiche gardait son
 * étiquette PDF mais désignait un fichier disparu : « Indexer » échouait, « Télécharger tous les PDF
 * manquants » l'ignorait, et la fenêtre des orphelins proposait de supprimer le vrai PDF.
 *
 * Le parcours réel : synchronisation, téléchargement et rattachement, seconde synchronisation,
 * dossier renommé, rechargement. Vrai service Zotero, vrais handlers de la bibliographie, vrais
 * fichiers dans un dossier temporaire. La source Zotero est simulée : aucun appel à l'API, aucune
 * base Zotero lue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IZoteroDataSource } from '../../../../backend/integrations/zotero/IZoteroDataSource.js';
import type { ZoteroAttachment, ZoteroCollection, ZoteroItem } from '../../../../backend/integrations/zotero/ZoteroAPI.js';
import type { Citation } from '../../../../backend/types/citation.js';

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), projectPath: '' }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => '/nulle-part' },
}));
vi.mock('../project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));
vi.mock('../reading-notes-indexing.js', () => ({ indexReadingNotesInBackground: () => undefined }));

const { zoteroService } = await import('../zotero-service.js');
const { setupBibliographyHandlers } = await import('../../ipc/handlers/bibliography-handlers.js');

// --- La bibliothèque Zotero simulée ---------------------------------------------------------

/** Ce que Zotero sait de la notice ; le titre change entre deux synchronisations. */
let zoteroTitle = '';
/** Le contenu du PDF que Zotero sert. */
let zoteroPdf = '';

const notice = (): ZoteroItem =>
  ({
    key: 'DUPO2020',
    version: 0,
    library: { type: 'user', id: 1, name: '' },
    data: {
      key: 'DUPO2020',
      version: 0,
      itemType: 'book',
      title: zoteroTitle,
      date: '2020',
      dateAdded: '2020-01-01',
      creators: [{ creatorType: 'author', lastName: 'Dupont', firstName: 'Jean' }],
    },
  }) as ZoteroItem;

const pdfAttachment: ZoteroAttachment = {
  key: 'PDF1ATT1',
  version: 0,
  data: { key: 'PDF1ATT1', version: 0, itemType: 'attachment', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'Dupont.pdf' },
};

const collection: ZoteroCollection = { key: 'THESE', version: 0, data: { key: 'THESE', version: 0, name: 'Thèse' } };

const zotero: IZoteroDataSource = {
  listCollections: async () => [collection],
  listSubcollections: async () => [],
  getCollection: async () => collection,
  listItems: async () => [notice()],
  getItem: async () => notice(),
  getItemChildren: async () => [],
  getItemAttachments: async () => [pdfAttachment],
  getItemNotes: async () => [],
  hasAttachments: async () => true,
  downloadFile: async (_key: string, savePath: string) => {
    fs.writeFileSync(savePath, zoteroPdf);
    return { filename: 'Dupont.pdf', size: zoteroPdf.length };
  },
  testConnection: async () => true,
  getItemMetadata: () => ({ title: '', authors: '', year: '', type: '' }),
};

// --- Le projet sur le disque ----------------------------------------------------------------

let root = '';
const bibOf = (project: string) => path.join(project, 'bibliography.bib');
const metadataOf = (project: string) =>
  JSON.parse(fs.readFileSync(path.join(project, '.cliodeck', 'bibliography-metadata.json'), 'utf8')) as {
    citations: Record<string, { zoteroAttachments?: Array<{ key: string; downloaded?: boolean; localPath?: string }> }>;
  };

const synchronize = (project: string) =>
  zoteroService.synchronizeProject({ mode: 'local', dataDirectory: '/zotero-simule', projectPath: project, collectionKey: 'THESE' });

const download = (project: string) =>
  zoteroService.downloadPDF({
    mode: 'local',
    dataDirectory: '/zotero-simule',
    attachmentKey: 'PDF1ATT1',
    filename: 'Dupont.pdf',
    targetDirectory: project,
  });

/** Le panneau charge la bibliographie du projet ouvert, comme à l'ouverture. */
async function load(project: string): Promise<Citation> {
  const result = (await h.handlers.get('bibliography:load-with-metadata')!(
    {},
    { filePath: bibOf(project), projectPath: project }
  )) as { success: boolean; citations: Citation[] };
  expect(result.success).toBe(true);
  return result.citations[0];
}

/** Ce que fait le panneau après un téléchargement : le PDF rattaché à sa pièce jointe. */
async function attach(project: string, citation: Citation, localPath: string): Promise<void> {
  const { id, zoteroKey, zoteroAttachments, zoteroTags, zoteroNotes, dateAdded, dateModified } = citation;
  const result = await h.handlers.get('bibliography:update-attachment')!(
    {},
    {
      projectPath: project,
      citation: { id, zoteroKey, zoteroAttachments, zoteroTags, zoteroNotes, dateAdded, dateModified },
      attachmentKey: 'PDF1ATT1',
      localPath,
    }
  );
  expect(result).toMatchObject({ success: true });
}

/**
 * Le projet « These », synchronisé, son PDF téléchargé et rattaché, puis synchronisé de nouveau
 * après une correction du titre dans Zotero : le `.bib` est réécrit avec le PDF.
 */
async function downloadedThenSynchronized(): Promise<string> {
  const project = path.join(root, 'These');
  fs.mkdirSync(path.join(project, '.cliodeck'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'project.json'),
    JSON.stringify({ name: 'Thèse', type: 'article', bibliographySource: { type: 'zotero', filePath: 'bibliography.bib', zoteroCollection: 'THESE' } })
  );
  h.projectPath = project;

  expect(await synchronize(project)).toMatchObject({ success: true, status: 'applied', written: true });
  const downloaded = await download(project);
  expect(downloaded).toMatchObject({ success: true, filePath: path.join(project, 'PDFs', 'Dupont.pdf') });
  await attach(project, await load(project), downloaded.filePath!);

  zoteroTitle = 'Le temps des archives, édition revue';
  expect(await synchronize(project)).toMatchObject({ success: true, status: 'applied', written: true });
  return project;
}

/** L'historien renomme le dossier du projet dans le Finder, puis le rouvre. */
function renamed(project: string): string {
  const to = path.join(root, 'These-2026');
  fs.renameSync(project, to);
  h.projectPath = to;
  return to;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-projet-renomme-'));
  zoteroTitle = 'Le temps des archives';
  zoteroPdf = '%PDF-1.4 Dupont, Le temps des archives';
  h.handlers.clear();
  setupBibliographyHandlers();
  // @ts-expect-error méthode privée remplacée par la source simulée
  vi.spyOn(zoteroService, 'createDataSource').mockImplementation(() => zotero);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('projet renommé : les PDF Zotero restent rattachés', () => {
  it('la seconde synchronisation écrit le PDF relatif au .bib, sans le chemin local de l’auteur', async () => {
    const project = await downloadedThenSynchronized();

    const bib = fs.readFileSync(bibOf(project), 'utf8');
    expect(bib).toContain('file = {PDFs/Dupont.pdf}');
    expect(bib).not.toContain(root);
    expect(metadataOf(project).citations.DUPO2020.zoteroAttachments).toEqual([
      expect.objectContaining({ key: 'PDF1ATT1', downloaded: true, localPath: 'PDFs/Dupont.pdf' }),
    ]);
  });

  it('dossier renommé : au rechargement, la fiche désigne son PDF, qui existe', async () => {
    const project = renamed(await downloadedThenSynchronized());

    const citation = await load(project);

    const pdf = path.join(project, 'PDFs', 'Dupont.pdf');
    expect(citation.file).toBe(pdf);
    // « Indexer » trouve le fichier ; « Télécharger tous les PDF manquants » ne l'écarte plus à tort.
    expect(fs.existsSync(citation.file!)).toBe(true);
    expect(citation.zoteroAttachments).toEqual([expect.objectContaining({ key: 'PDF1ATT1', downloaded: true, localPath: pdf })]);
  });

  it('dossier renommé : retélécharger le PDF réécrit son fichier, sans en faire une copie', async () => {
    const project = renamed(await downloadedThenSynchronized());
    zoteroPdf = '%PDF-1.4 Dupont, Le temps des archives, version corrigée dans Zotero';

    const again = await download(project);

    expect(again).toMatchObject({ success: true, filePath: path.join(project, 'PDFs', 'Dupont.pdf') });
    expect(fs.readdirSync(path.join(project, 'PDFs'))).toEqual(['Dupont.pdf']);
    expect(fs.readFileSync(path.join(project, 'PDFs', 'Dupont.pdf'), 'utf8')).toContain('version corrigée');
  });

  it('dossier renommé : la synchronisation suivante garde le PDF, en chemins relatifs', async () => {
    const project = renamed(await downloadedThenSynchronized());
    zoteroTitle = 'Le temps des archives, troisième édition';

    expect(await synchronize(project)).toMatchObject({ success: true, status: 'applied', written: true });

    expect(fs.readFileSync(bibOf(project), 'utf8')).toContain('file = {PDFs/Dupont.pdf}');
    expect(metadataOf(project).citations.DUPO2020.zoteroAttachments).toEqual([
      expect.objectContaining({ key: 'PDF1ATT1', downloaded: true, localPath: 'PDFs/Dupont.pdf' }),
    ]);
    expect((await load(project)).file).toBe(path.join(project, 'PDFs', 'Dupont.pdf'));
  });
});
