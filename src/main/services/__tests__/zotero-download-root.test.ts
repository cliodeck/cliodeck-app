/**
 * Télécharger puis rattacher un PDF Zotero dans un projet dont le dossier a disparu (L03-3).
 *
 * L'interface télécharge toujours avant de rattacher (`downloadAndIndexZoteroPDF`). Le
 * téléchargement créait `<projet>/PDFs` par un `mkdir` récursif : le projet renaissait, vide, à son
 * ancien chemin, si bien que la garde du rattachement trouvait sa racine et écrivait
 * `.cliodeck/bibliography-metadata.json` dans ce squelette. Le refus porte maintenant un code, dès
 * le téléchargement, et rien n'est écrit.
 *
 * Service réel, source Zotero simulée, comme `zotero-download-names.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  ipcMain: { handle: vi.fn() },
}));

const { zoteroService } = await import('../zotero-service.js');
const { BibliographyMetadataService } = await import('../../../../backend/services/BibliographyMetadataService.js');

let workDir = '';
let project = '';
let transfers = 0;

const download = () =>
  zoteroService.downloadPDF({
    mode: 'local',
    dataDirectory: '/zotero',
    attachmentKey: 'ATT1',
    filename: 'braudel.pdf',
    targetDirectory: project,
  } as Parameters<typeof zoteroService.downloadPDF>[0]);

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-zotero-racine-'));
  project = path.join(workDir, 'Thèse');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'project.json'), '{"name":"Thèse"}');
  transfers = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  // @ts-expect-error méthode privée remplacée par une source simulée
  vi.spyOn(zoteroService, 'createDataSource').mockImplementation(() => ({
    downloadFile: async (_key: string, savePath: string) => {
      transfers += 1;
      fs.writeFileSync(savePath, '%PDF-1.4 La Méditerranée');
      return { filename: 'braudel.pdf', size: 24 };
    },
    close: () => undefined,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('télécharger un PDF Zotero dans un projet disparu', () => {
  it('refusé par son code, sans transfert ni squelette ; le rattachement qui suivrait est refusé aussi', async () => {
    // Le dossier parent est renommé pendant que le projet est ouvert : son chemin n'existe plus.
    fs.renameSync(project, path.join(workDir, 'Thèse (ancienne)'));

    const result = await download();

    expect(result).toMatchObject({ success: false, code: 'project_root_missing' });
    expect(transfers).toBe(0);
    expect(fs.existsSync(project)).toBe(false);

    const citation = {
      id: 'Braudel_1949',
      zoteroKey: 'ABCD1234',
      zoteroAttachments: [{ key: 'ATT1', filename: 'braudel.pdf', contentType: 'application/pdf', downloaded: false }],
    } as never;
    await expect(
      BibliographyMetadataService.patchAttachment(project, citation, 'ATT1', path.join(project, 'PDFs', 'braudel.pdf'))
    ).rejects.toMatchObject({ code: 'project_root_missing' });
    expect(fs.existsSync(project)).toBe(false);
  });

  it('témoin : le projet en place, le PDF arrive dans PDFs/', async () => {
    const result = await download();

    expect(result).toMatchObject({ success: true, filePath: path.join(project, 'PDFs', 'braudel.pdf') });
    expect(fs.readFileSync(path.join(project, 'PDFs', 'braudel.pdf'), 'utf8')).toBe('%PDF-1.4 La Méditerranée');
  });
});
