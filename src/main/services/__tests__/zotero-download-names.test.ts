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

  it('métadonnées illisibles : le téléchargement passe, et la comparaison de contenu protège le fichier en place', async () => {
    // Illisibles, elles ne disent plus à qui est chaque fichier (S07-1-10) : ce n'est pas une
    // raison d'arrêter le téléchargement, ni d'écraser un fichier de même nom.
    fs.mkdirSync(path.join(project, '.cliodeck'), { recursive: true });
    fs.writeFileSync(path.join(project, '.cliodeck', 'bibliography-metadata.json'), '{"version": 2, "citat');
    fs.mkdirSync(path.join(project, 'PDFs'), { recursive: true });
    const existing = path.join(project, 'PDFs', SAFE);
    fs.writeFileSync(existing, library.QQBJJVQY);

    const other = await download('GC9BPFL6');

    expect(other.success).toBe(true);
    expect(other.filePath).not.toBe(existing);
    expect(fs.readFileSync(existing, 'utf8')).toBe(library.QQBJJVQY);
  });

  it('un échec de téléchargement ne laisse aucun fichier partiel', async () => {
    const failed = await download('INCONNUE');
    expect(failed.success).toBe(false);
    const pdfDir = path.join(project, 'PDFs');
    expect(fs.existsSync(pdfDir) ? fs.readdirSync(pdfDir) : []).toEqual([]);
  });

  it('n’écrit jamais hors de PDFs/, ni pour une clé hostile, ni pour un nom « .. »', async () => {
    library['../../evil'] = '%PDF hostile';
    const byKey = await download('../../evil');
    expect(byKey.success).toBe(false);

    library.GOODKEY1 = '%PDF nom hostile';
    const byName = await zoteroService.downloadPDF({
      mode: 'local',
      dataDirectory: '/zotero',
      attachmentKey: 'GOODKEY1',
      filename: '..',
      targetDirectory: project,
    } as Parameters<typeof zoteroService.downloadPDF>[0]);
    expect(byName.success).toBe(false);

    const outside = fs.readdirSync(project).filter((n) => !['PDFs', '.cliodeck'].includes(n));
    expect(outside).toEqual([]);
    expect(fs.existsSync(path.join(project, '..', 'evil'))).toBe(false);
  });
});

const twoHoursAgo = () => new Date(Date.now() - 2 * 60 * 60 * 1000);

/**
 * Un temporaire par appel (`.<clé>.<uuid>.part`) n'est plus réécrit au téléchargement suivant,
 * comme l'était `.<clé>.part`. Si l'app est tuée pendant un transfert, le `finally` qui le retire
 * ne s'exécute pas : sans balayage, il restait à jamais dans `PDFs/`, invisible.
 */
describe('téléchargement Zotero : temporaires abandonnés', () => {
  it('un temporaire laissé par un transfert interrompu est retiré au téléchargement suivant ; rien d’autre', async () => {
    const pdfDir = path.join(project, 'PDFs');
    fs.mkdirSync(pdfDir, { recursive: true });
    const abandoned = '.QQBJJVQY.0b7e4c1a-6a8e-4f0e-9f62-1d2c3b4a5e6f.part';
    const legacy = '.GC9BPFL6.part';
    // Modifié il y a un instant : peut-être le transfert d'un autre ClioDeck ouvert sur ce projet.
    const recent = '.AUTRE001.5f1d2c3b-4a5e-4f0e-9f62-0b7e4c1a6a8e.part';
    // Des fichiers de l'historien, même anciens, même en .part.
    const ownFiles = ['brouillon.part', '.notes.part', 'Rapport.pdf'];
    for (const name of [abandoned, legacy, recent, ...ownFiles]) fs.writeFileSync(path.join(pdfDir, name), '%PDF-1.4 à moitié');
    for (const name of [abandoned, legacy, ...ownFiles]) fs.utimesSync(path.join(pdfDir, name), twoHoursAgo(), twoHoursAgo());

    expect((await download('GC9BPFL6')).success).toBe(true);

    expect(fs.readdirSync(pdfDir).sort()).toEqual([recent, ...ownFiles, SAFE].sort());
  });
});

/**
 * Deux téléchargements en même temps (S07-1-4). Le nom se décidait avant le transfert, sur des
 * propriétaires que le renderer n'écrit qu'après coup : les deux appels voyaient le nom libre, et
 * le second `rename` écrasait le premier. Le fichier temporaire, nommé par la seule clé, était
 * commun à deux appels de même clé : le premier fini emportait celui de l'autre (ENOENT).
 *
 * La source retient chaque transfert : ses octets sont écrits, sa fin attend qu'on la relâche.
 * Aucun délai : l'ordre est forcé par des promesses.
 */
describe('téléchargement Zotero : deux transferts en même temps', () => {
  interface HeldTransfer {
    key: string;
    release: () => void;
  }
  /** Les transferts en cours, dans l'ordre d'arrivée. */
  let held: HeldTransfer[] = [];
  let arrived: () => void = () => undefined;

  function heldSource() {
    return {
      downloadFile: async (key: string, savePath: string) => {
        if (!(key in library)) throw new Error(`pièce jointe inconnue : ${key}`);
        fs.writeFileSync(savePath, library[key]);
        let release: () => void = () => undefined;
        const done = new Promise<void>((resolve) => {
          release = resolve;
        });
        held.push({ key, release });
        arrived();
        await done;
        return { filename: key, size: library[key].length };
      },
      close: () => {},
    };
  }

  /**
   * Attend que `count` transferts soient en cours. Le suivant ne part qu'ensuite : sous charge,
   * deux appels lancés ensemble peuvent commencer leur transfert dans l'autre ordre.
   */
  async function transfersStarted(count: number): Promise<void> {
    while (held.length < count) {
      await new Promise<void>((resolve) => {
        arrived = resolve;
      });
    }
  }

  beforeEach(() => {
    held = [];
    // @ts-expect-error méthode privée remplacée par une source qui retient les transferts
    vi.spyOn(zoteroService, 'createDataSource').mockImplementation(heldSource);
  });

  const pdfFiles = () => fs.readdirSync(path.join(project, 'PDFs')).sort();

  it('deux pièces jointes de même nom, la seconde finie d’abord : deux fichiers, chacun son contenu', async () => {
    const x = download('QQBJJVQY');
    await transfersStarted(1);
    const y = download('GC9BPFL6');
    await transfersStarted(2);

    held[1].release();
    const second = await y;
    held[0].release();
    const first = await x;

    expect(second).toMatchObject({ success: true, filePath: path.join(project, 'PDFs', SAFE) });
    expect(first).toMatchObject({
      success: true,
      filePath: path.join(project, 'PDFs', '2023_-_Documents_sauvegardés_QQBJJVQY.pdf'),
    });
    expect(fs.readFileSync(first.filePath!, 'utf8')).toBe(library.QQBJJVQY);
    expect(fs.readFileSync(second.filePath!, 'utf8')).toBe(library.GC9BPFL6);
    expect(pdfFiles()).toEqual(['2023_-_Documents_sauvegardés.pdf', '2023_-_Documents_sauvegardés_QQBJJVQY.pdf']);
  });

  it('la même pièce jointe deux fois, la seconde finie d’abord : un seul fichier, sans ENOENT', async () => {
    const once = download('QQBJJVQY');
    await transfersStarted(1);
    const twice = download('QQBJJVQY');
    await transfersStarted(2);

    held[1].release();
    const second = await twice;
    held[0].release();
    const first = await once;

    expect(second).toMatchObject({ success: true, filePath: path.join(project, 'PDFs', SAFE) });
    expect(first).toMatchObject({ success: true, filePath: path.join(project, 'PDFs', SAFE) });
    expect(fs.readFileSync(path.join(project, 'PDFs', SAFE), 'utf8')).toBe(library.QQBJJVQY);
    // Aucun temporaire laissé derrière.
    expect(pdfFiles()).toEqual([SAFE]);
  });

  /**
   * Le cas réel : deux clics de suite, deux copies (mode local) qui finissent presque ensemble.
   * Les deux rangements se chevauchent : chacun relit les propriétaires (attentes de lecture, d'où
   * le fichier de métadonnées présent), voit le nom libre et le prend ; sans le verrou de `PDFs/`,
   * le second `rename` écrase le premier. Le chevauchement dépend de l'ordre des lectures : on le
   * rejoue plusieurs fois. Avec le verrou, aucun tour ne peut écraser.
   */
  it('deux pièces jointes de même nom, finies ensemble : jamais un PDF à la place de l’autre', async () => {
    const overwritten: string[] = [];
    for (let round = 0; round < 40; round++) {
      fs.rmSync(path.join(project, 'PDFs'), { recursive: true, force: true });
      recordDownloaded([{ citekey: 'autre_2020', attachmentKey: 'AUTRE001', localPath: path.join(project, 'PDFs', 'autre.pdf') }]);
      held = [];

      const x = download('QQBJJVQY');
      await transfersStarted(1);
      const y = download('GC9BPFL6');
      await transfersStarted(2);
      held[0].release();
      held[1].release();
      const [first, second] = await Promise.all([x, y]);

      expect(first.success && second.success).toBe(true);
      const files = pdfFiles();
      const intact =
        first.filePath !== second.filePath &&
        files.length === 2 &&
        fs.readFileSync(first.filePath!, 'utf8') === library.QQBJJVQY &&
        fs.readFileSync(second.filePath!, 'utf8') === library.GC9BPFL6;
      if (!intact) overwritten.push(`tour ${round} : ${files.join(', ')}`);
    }

    expect(overwritten).toEqual([]);
  });

  it('un transfert en cours, même immobile depuis longtemps, n’est jamais balayé par un autre téléchargement', async () => {
    const pdfDir = path.join(project, 'PDFs');
    const x = download('QQBJJVQY');
    await transfersStarted(1);
    // Une connexion très lente : le temporaire de X n'a pas bougé depuis deux heures.
    for (const name of fs.readdirSync(pdfDir)) fs.utimesSync(path.join(pdfDir, name), twoHoursAgo(), twoHoursAgo());
    const y = download('GC9BPFL6');
    await transfersStarted(2);

    held[1].release();
    expect(await y).toMatchObject({ success: true });
    held[0].release();
    const first = await x;

    expect(first).toMatchObject({ success: true });
    expect(fs.readFileSync(first.filePath!, 'utf8')).toBe(library.QQBJJVQY);
    expect(pdfFiles()).toEqual(['2023_-_Documents_sauvegardés.pdf', '2023_-_Documents_sauvegardés_QQBJJVQY.pdf']);
  });

  it('un transfert qui échoue pendant qu’un autre aboutit : rien de partiel, l’autre intact', async () => {
    library.FAILKEY1 = '%PDF-1.4 jamais fini';
    const failing = heldSource();
    const working = heldSource();
    let calls = 0;
    // @ts-expect-error méthode privée remplacée : le premier transfert échoue après avoir écrit
    vi.spyOn(zoteroService, 'createDataSource').mockImplementation(() => {
      calls++;
      if (calls === 1) {
        return {
          ...failing,
          downloadFile: async (key: string, savePath: string) => {
            await failing.downloadFile(key, savePath);
            throw new Error('connexion coupée');
          },
        };
      }
      return working;
    });

    const broken = download('FAILKEY1');
    await transfersStarted(1);
    const good = download('GC9BPFL6');
    await transfersStarted(2);
    held[0].release();
    held[1].release();

    expect(await broken).toMatchObject({ success: false });
    expect(await good).toMatchObject({ success: true, filePath: path.join(project, 'PDFs', SAFE) });
    expect(pdfFiles()).toEqual([SAFE]);
    expect(fs.readFileSync(path.join(project, 'PDFs', SAFE), 'utf8')).toBe(library.GC9BPFL6);
  });
});
