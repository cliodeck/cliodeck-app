/**
 * Deux pièces jointes Zotero de même nom ne s'écrasent plus (#131).
 *
 * Cas réel : « 2023 - Documents sauvegardés.pdf », nom par défaut des exports
 * Europresse, porté par des pièces jointes de deux références différentes. Le
 * second téléchargement remplaçait le premier ; la référence perdante gardait
 * une fiche « téléchargée » pointant sur le PDF de l'autre.
 *
 * Service réel, source Zotero simulée : on regarde les fichiers sur le disque.
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

const EUROPRESSE = '2023 - Documents sauvegardés.pdf';
const SAFE = '2023_-_Documents_sauvegardés.pdf';

let project = '';
/** Contenu servi par la « bibliothèque Zotero », par clé de pièce jointe. */
let library: Record<string, string> = {};

function fakeSource() {
  return {
    downloadFile: async (key: string, savePath: string) => {
      if (!(key in library)) throw new Error(`pièce jointe inconnue : ${key}`);
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, library[key]);
      return { filename: key, size: library[key].length };
    },
    close: () => {},
  };
}

function recordDownloaded(owners: Array<{ citekey: string; attachmentKey: string; localPath: string }>) {
  const citations: Record<string, unknown> = {};
  for (const o of owners) {
    citations[o.citekey] = {
      id: o.citekey,
      zoteroAttachments: [{ key: o.attachmentKey, filename: EUROPRESSE, downloaded: true, localPath: o.localPath }],
    };
  }
  fs.mkdirSync(path.join(project, '.cliodeck'), { recursive: true });
  fs.writeFileSync(
    path.join(project, '.cliodeck', 'bibliography-metadata.json'),
    JSON.stringify({ version: 2, lastUpdated: new Date().toISOString(), citations }),
  );
}

const download = (attachmentKey: string) =>
  zoteroService.downloadPDF({
    mode: 'local',
    dataDirectory: '/zotero',
    attachmentKey,
    filename: EUROPRESSE,
    targetDirectory: project,
  } as Parameters<typeof zoteroService.downloadPDF>[0]);

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-zotero-noms-'));
  library = {
    QQBJJVQY: '%PDF-1.4 La guerre de l’intelligence artificielle (L’Obs)',
    GC9BPFL6: '%PDF-1.4 Revue de presse ChatGPT',
  };
  // @ts-expect-error méthode privée remplacée par une source simulée
  vi.spyOn(zoteroService, 'createDataSource').mockImplementation(fakeSource);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('téléchargement Zotero : pièces jointes de même nom', () => {
  it('ne remplace pas le PDF d’une autre référence : le second prend un nom unique', async () => {
    const first = await download('QQBJJVQY');
    expect(first.filePath).toBe(path.join(project, 'PDFs', SAFE));
    recordDownloaded([{ citekey: 'guerre_2023', attachmentKey: 'QQBJJVQY', localPath: first.filePath! }]);

    const second = await download('GC9BPFL6');

    expect(second.success).toBe(true);
    expect(second.filePath).not.toBe(first.filePath);
    expect(path.basename(second.filePath!)).toBe('2023_-_Documents_sauvegardés_GC9BPFL6.pdf');
    // Chaque référence garde son propre texte.
    expect(fs.readFileSync(first.filePath!, 'utf8')).toContain('La guerre');
    expect(fs.readFileSync(second.filePath!, 'utf8')).toContain('Revue de presse');
  });

  it('retélécharger la même pièce jointe réécrit son propre fichier, sans en créer un autre', async () => {
    const first = await download('QQBJJVQY');
    recordDownloaded([{ citekey: 'guerre_2023', attachmentKey: 'QQBJJVQY', localPath: first.filePath! }]);
    library.QQBJJVQY = '%PDF-1.4 version corrigée dans Zotero';

    const again = await download('QQBJJVQY');

    expect(again.filePath).toBe(first.filePath);
    expect(fs.readFileSync(again.filePath!, 'utf8')).toContain('version corrigée');
    expect(fs.readdirSync(path.join(project, 'PDFs'))).toEqual([SAFE]);
  });

  it('un fichier de même nom sans propriétaire connu : réutilisé s’il est identique, préservé sinon', async () => {
    fs.mkdirSync(path.join(project, 'PDFs'), { recursive: true });
    const existing = path.join(project, 'PDFs', SAFE);

    fs.writeFileSync(existing, library.GC9BPFL6);
    expect((await download('GC9BPFL6')).filePath).toBe(existing);

    fs.writeFileSync(existing, '%PDF-1.4 un fichier déposé à la main');
    const other = await download('QQBJJVQY');
    expect(other.filePath).not.toBe(existing);
    expect(fs.readFileSync(existing, 'utf8')).toContain('déposé à la main');
  });

  it('un échec de téléchargement ne laisse aucun fichier partiel', async () => {
    const failed = await download('INCONNUE');
    expect(failed.success).toBe(false);
    const pdfDir = path.join(project, 'PDFs');
    expect(fs.existsSync(pdfDir) ? fs.readdirSync(pdfDir) : []).toEqual([]);
  });
});
