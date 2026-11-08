/**
 * Un PDF rattaché pendant une synchronisation Zotero reste rattaché après elle (S07-1-6).
 *
 * La synchronisation lit les métadonnées à son début, lit Zotero (une à deux minutes pour 300
 * notices en mode API), puis réécrivait tout `bibliography-metadata.json` depuis l'état lu au
 * début. Un PDF téléchargé et rattaché pendant ce temps perdait son rattachement : au lancement
 * suivant, sa référence n'avait plus de PDF, et son fichier passait pour orphelin.
 *
 * Vrai service, vrai `BibliographyMetadataService`, fichiers réels dans un projet temporaire. La
 * source Zotero est simulée (aucun appel à l'API, aucune base Zotero lue) : sa lecture des notices
 * est retenue par une promesse pendant que le rattachement s'écrit. Aucun délai.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IZoteroDataSource } from '../../../../backend/integrations/zotero/IZoteroDataSource.js';
import type { ZoteroAttachment, ZoteroCollection, ZoteroItem } from '../../../../backend/integrations/zotero/ZoteroAPI.js';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../reading-notes-indexing.js', () => ({ indexReadingNotesInBackground: () => undefined }));

const { zoteroService } = await import('../zotero-service.js');
const { BibliographyMetadataService } = await import('../../../../backend/services/BibliographyMetadataService.js');

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
      date: '2023',
      dateAdded: '2023-01-01',
      creators: [{ creatorType: 'author', lastName, firstName: 'A.' }],
    },
  }) as ZoteroItem;

const pdfAttachment = (key: string, filename: string): ZoteroAttachment => ({
  key,
  version: 0,
  data: { key, version: 0, itemType: 'attachment', linkMode: 'imported_file', contentType: 'application/pdf', filename },
});

const collection = (key: string): ZoteroCollection => ({ key, version: 0, data: { key, version: 0, name: key } });

/**
 * Une source dont la lecture des notices attend qu'on la relâche : `reading` se résout quand elle
 * commence, `release` la laisse finir.
 */
function heldSource(
  items: ZoteroItem[],
  attachments: Record<string, ZoteroAttachment[]>
): { source: IZoteroDataSource; reading: Promise<void>; release: () => void } {
  let started: () => void = () => undefined;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source: IZoteroDataSource = {
    listCollections: async () => [collection('COLL')],
    listSubcollections: async () => [],
    getCollection: async (key: string) => collection(key),
    listItems: async () => {
      started();
      await released;
      return [...items];
    },
    getItem: async () => {
      throw new Error('inutile ici');
    },
    getItemChildren: async () => [],
    getItemAttachments: async (key: string) => [...(attachments[key] ?? [])],
    getItemNotes: async () => [],
    hasAttachments: async () => false,
    downloadFile: async () => ({ filename: '', size: 0 }),
    testConnection: async () => true,
    getItemMetadata: () => ({ title: '', authors: '', year: '', type: '' }),
  };
  return { source, reading, release };
}

/** Branche la source retenue à la place de Zotero. */
function holdZotero(items: ZoteroItem[]): { reading: Promise<void>; release: () => void } {
  const held = heldSource(items, ATTACHMENTS);
  // @ts-expect-error méthode privée remplacée par la source simulée
  vi.spyOn(zoteroService, 'createDataSource').mockImplementation(() => held.source);
  return held;
}

// --- Le projet sur le disque ----------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-synchro-rattachement-'));
let project = '';
const metadataPath = () => BibliographyMetadataService.getMetadataPath(project);

/** Les pièces jointes que les métadonnées rattachent à une notice. */
const attachmentsOf = (zoteroKey: string) => {
  const metadata = JSON.parse(fs.readFileSync(metadataPath(), 'utf-8')) as {
    citations: Record<string, { zoteroAttachments?: Array<{ key: string; downloaded?: boolean; localPath?: string }> }>;
  };
  return metadata.citations[zoteroKey]?.zoteroAttachments ?? [];
};

const X = notice('XKEY2023', 'La guerre de l’intelligence artificielle', 'Martin');
const Y = notice('YKEY2023', 'Revue de presse', 'Leduc');
const ATTACHMENTS = { XKEY2023: [pdfAttachment('QQBJJVQY', '2023 - Documents sauvegardés.pdf')] };

const synchronize = () =>
  zoteroService.synchronizeProject({
    mode: 'local',
    dataDirectory: '/zotero-simule',
    projectPath: project,
    collectionKey: 'COLL',
  });

/** Un projet déjà synchronisé avec X, dont le PDF n'est pas encore téléchargé. */
async function makeProject(): Promise<void> {
  project = path.join(root, `p-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(project, '.cliodeck'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'project.json'),
    JSON.stringify({ name: 'Thèse', type: 'article', bibliographySource: { type: 'zotero', filePath: 'bibliography.bib', zoteroCollection: 'COLL' } })
  );
  const { reading, release } = holdZotero([X]);
  const done = synchronize();
  await reading;
  release();
  expect(await done).toMatchObject({ success: true, status: 'applied', written: true });
  vi.restoreAllMocks();
  expect(attachmentsOf('XKEY2023')).toEqual([expect.objectContaining({ key: 'QQBJJVQY', downloaded: false })]);
}

/** La référence de X telle que le panneau la tient. */
const panelCitationOfX = () => ({
  id: 'Martin_2023',
  zoteroKey: 'XKEY2023',
  zoteroAttachments: [{ key: 'QQBJJVQY', filename: '2023 - Documents sauvegardés.pdf', contentType: 'application/pdf', downloaded: false }],
});

beforeEach(async () => {
  await makeProject();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('synchronisation Zotero et rattachement simultané', () => {
  it('le PDF de X, rattaché pendant que la synchronisation lit Zotero, reste rattaché après elle', async () => {
    // Y arrive dans la collection : la synchronisation aura à écrire.
    const { reading, release } = holdZotero([X, Y]);
    const pdf = path.join(project, 'PDFs', '2023_-_Documents_sauvegardés.pdf');

    const sync = synchronize();
    await reading;
    await BibliographyMetadataService.patchAttachment(project, panelCitationOfX(), 'QQBJJVQY', pdf);
    release();
    const result = await sync;

    expect(result).toMatchObject({ success: true, status: 'applied', written: true });
    expect(attachmentsOf('XKEY2023')).toEqual([
      expect.objectContaining({ key: 'QQBJJVQY', downloaded: true, localPath: pdf }),
    ]);
    // Ce que la synchronisation apporte est bien écrit.
    expect(Object.keys(JSON.parse(fs.readFileSync(metadataPath(), 'utf-8')).citations).sort()).toEqual(['XKEY2023', 'YKEY2023']);
  });

  it('métadonnées devenues illisibles pendant la synchronisation : rien n’y est écrit, et l’échec ne dit pas « rien n’a été écrit »', async () => {
    const { reading, release } = holdZotero([X, Y]);
    const damaged = fs.readFileSync(metadataPath(), 'utf-8').slice(0, 50);

    const sync = synchronize();
    await reading;
    fs.writeFileSync(metadataPath(), damaged);
    release();
    const result = await sync;

    // Le .bib est déjà réécrit à ce moment : ce n'est pas le refus d'avant toute écriture. Un code
    // et les deux fichiers, pas une phrase : le renderer la formule dans la langue de l'historien.
    expect(result).toMatchObject({
      success: false,
      error: 'metadata-unreadable-after-bib',
      bibFile: 'bibliography.bib',
      file: path.join('.cliodeck', 'bibliography-metadata.json'),
    });
    expect(fs.readFileSync(metadataPath(), 'utf-8')).toBe(damaged);
    // Ni fichier neuf à côté, ni mise de côté : l'historien le répare ou en remet une copie.
    const besideMetadata = fs.readdirSync(path.join(project, '.cliodeck')).filter((name) => /metadata|^\.~/.test(name));
    expect(besideMetadata).toEqual(['bibliography-metadata.json']);
    expect(fs.readFileSync(path.join(project, 'bibliography.bib'), 'utf-8')).toContain('Revue de presse');
  });

  /**
   * La synchronisation refait une clé (`Martin_`, héritée de l'ancien générateur) et les
   * métadonnées deviennent illisibles pendant qu'elle lit Zotero. Le `.bib` porte déjà la nouvelle
   * clé ; la note de lecture doit la suivre aussi. Sautée avec les métadonnées, elle restait sur
   * l'ancienne : la synchronisation suivante, qui garde une clé valide et unique, ne refait plus
   * rien, et la note restait coupée de sa référence.
   */
  it('métadonnées devenues illisibles et clé refaite : la note de lecture suit quand même le .bib', async () => {
    const bibPath = path.join(project, 'bibliography.bib');
    fs.writeFileSync(bibPath, fs.readFileSync(bibPath, 'utf-8').replace('{Martin_2023,', '{Martin_,'));
    const notesDir = path.join(project, 'reading-notes');
    fs.mkdirSync(notesDir);
    fs.writeFileSync(
      path.join(notesDir, 'Martin_.md'),
      '---\ncitekey: Martin_\nzotero_key: XKEY2023\ntags: []\n---\n\nL’article cite trois rapports parlementaires.\n'
    );
    const { reading, release } = holdZotero([X, Y]);
    const damaged = fs.readFileSync(metadataPath(), 'utf-8').slice(0, 50);

    const sync = synchronize();
    await reading;
    fs.writeFileSync(metadataPath(), damaged);
    release();
    const result = await sync;

    expect(result).toMatchObject({ success: false, error: 'metadata-unreadable-after-bib' });
    expect(fs.readFileSync(bibPath, 'utf-8')).toContain('{Martin_2023,');
    expect(fs.readdirSync(notesDir)).toEqual(['Martin_2023.md']);
    const note = fs.readFileSync(path.join(notesDir, 'Martin_2023.md'), 'utf-8');
    expect(note).toContain('citekey: Martin_2023');
    expect(note).toContain('L’article cite trois rapports parlementaires.');
    expect(fs.readFileSync(metadataPath(), 'utf-8')).toBe(damaged);
  });
});
