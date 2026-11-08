/**
 * `bibliography:update-attachment` accepte la référence telle que le panneau la tient, venue de
 * Zotero et relue des métadonnées, `null` compris.
 *
 * L'API Zotero écrit `"md5": null` pour une pièce jointe dont le fichier n'est pas sur son
 * stockage (quota plein, fichier jamais envoyé) : `toCitation` le recopie, la synchronisation
 * l'écrit, le chargement le rend au panneau, et le rattachement renvoie la liste entière des
 * pièces jointes. Le schéma refusait ce `null` avant le handler : le PDF téléchargé restait dans
 * `PDFs/` sans jamais pouvoir être rattaché, à chaque essai.
 *
 * Vrai handler (schéma zod compris), vrai `BibliographyMetadataService`, vrais fichiers ; seul le
 * projet courant du main est simulé. Aucun appel à Zotero : la notice est fabriquée.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ZoteroAttachment, ZoteroItem } from '../../../../../backend/integrations/zotero/ZoteroAPI.js';

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), projectPath: '' }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/nulle-part' },
}));
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));
vi.mock('../../../services/reading-notes-indexing.js', () => ({ indexReadingNotesInBackground: () => undefined }));

import { setupBibliographyHandlers } from '../bibliography-handlers.js';
import { BibliographyMetadataService } from '../../../../../backend/services/BibliographyMetadataService.js';
import { zoteroItemToCitation } from '../../../../../backend/integrations/zotero/toCitation.js';
import type { Citation } from '../../../../../backend/types/citation.js';

type Response = { success: boolean; error?: string; code?: string };

/** Une pièce jointe PDF telle que l'API web la rend ; `md5` et `mtime` à `null` sans fichier stocké. */
const apiAttachment = (key: string, filename: string, stored: boolean): ZoteroAttachment =>
  ({
    key,
    version: 3,
    data: {
      key,
      version: 3,
      itemType: 'attachment',
      linkMode: 'imported_file',
      contentType: 'application/pdf',
      filename,
      dateModified: '2023-05-02T10:00:00Z',
      md5: stored ? '9e107d9d372bb6826bd81d3542a419d6' : null,
      mtime: stored ? 1683021600000 : null,
    },
  }) as unknown as ZoteroAttachment;

/** Une notice de presse à deux PDF : le premier stocké chez Zotero, le second non (quota plein). */
const notice: ZoteroItem = {
  key: 'NOTICE23',
  version: 3,
  library: { type: 'user', id: 1, name: '' },
  data: {
    key: 'NOTICE23',
    version: 3,
    itemType: 'newspaperArticle',
    title: 'La guerre de l’intelligence artificielle',
    date: '2023',
    creators: [{ creatorType: 'author', lastName: 'Martin', firstName: 'A.' }],
    attachments: [
      apiAttachment('QQBJJVQY', '2023 - Documents sauvegardés.pdf', true),
      apiAttachment('GC9BPFL6', '2023 - Documents sauvegardés (2).pdf', false),
    ],
  },
};

const metadataPath = () => BibliographyMetadataService.getMetadataPath(h.projectPath);
/** Le chemin d'un PDF du projet, tel que le fichier le range : relatif au projet (S07-2-1). */
const kept = (pdf: string) => path.relative(h.projectPath, pdf).split(path.sep).join('/');
const attachmentsOnDisk = () =>
  (JSON.parse(fs.readFileSync(metadataPath(), 'utf-8')) as {
    citations: Record<string, { zoteroAttachments: Array<Record<string, unknown>> }>;
  }).citations.NOTICE23.zoteroAttachments;

/**
 * La référence telle que le panneau la tient après une synchronisation : lue du `.bib` (sans
 * pièces jointes), complétée par les métadonnées, puis passée par l'IPC.
 */
async function panelCitation(): Promise<Citation> {
  const fromZotero = zoteroItemToCitation(notice, 'Martin_2023');
  await BibliographyMetadataService.saveFromSync(h.projectPath, [fromZotero]);
  const fromBib: Citation = { ...fromZotero, zoteroAttachments: undefined };
  const [merged] = BibliographyMetadataService.mergeCitationsWithMetadata(
    [fromBib],
    await BibliographyMetadataService.loadMetadata(h.projectPath),
    h.projectPath
  );
  return JSON.parse(JSON.stringify(merged)) as Citation;
}

/** Ce que `attach` (zoteroSlice) envoie. */
const updateAttachment = (citation: Citation, attachmentKey: string, localPath: string) => {
  const { id, zoteroKey, zoteroAttachments, zoteroTags, zoteroNotes, dateAdded, dateModified } = citation;
  return h.handlers.get('bibliography:update-attachment')!(
    {},
    {
      projectPath: h.projectPath,
      citation: { id, zoteroKey, zoteroAttachments, zoteroTags, zoteroNotes, dateAdded, dateModified },
      attachmentKey,
      localPath,
    }
  ) as Promise<Response>;
};

beforeEach(() => {
  h.projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-rattachement-'));
  h.handlers.clear();
  setupBibliographyHandlers();
});

afterEach(() => {
  fs.rmSync(h.projectPath, { recursive: true, force: true });
});

describe('bibliography:update-attachment — la référence telle que Zotero l’a donnée', () => {
  it('le préalable : la pièce jointe non stockée arrive au panneau avec md5 à null', async () => {
    const citation = await panelCitation();

    expect(citation.zoteroAttachments?.map((att) => att.md5)).toEqual(['9e107d9d372bb6826bd81d3542a419d6', null]);
  });

  it('rattacher le PDF stocké d’une notice dont l’autre PDF n’a pas de md5 : accepté et écrit', async () => {
    const citation = await panelCitation();
    const pdf = path.join(h.projectPath, 'PDFs', '2023_-_Documents_sauvegardés.pdf');

    const result = await updateAttachment(citation, 'QQBJJVQY', pdf);

    expect(result).toMatchObject({ success: true });
    expect(attachmentsOnDisk()).toEqual([
      expect.objectContaining({ key: 'QQBJJVQY', downloaded: true, localPath: kept(pdf) }),
      expect.objectContaining({ key: 'GC9BPFL6', downloaded: false, md5: null }),
    ]);
  });

  it('rattacher le PDF sans md5 lui-même (mode local après une synchronisation par l’API) : accepté et écrit', async () => {
    const citation = await panelCitation();
    const pdf = path.join(h.projectPath, 'PDFs', '2023_-_Documents_sauvegardés_(2).pdf');

    const result = await updateAttachment(citation, 'GC9BPFL6', pdf);

    expect(result).toMatchObject({ success: true });
    expect(attachmentsOnDisk()[1]).toMatchObject({ key: 'GC9BPFL6', downloaded: true, localPath: kept(pdf) });
  });

  it('entrée absente des métadonnées, créée depuis la référence : les null n’empêchent rien', async () => {
    const citation = await panelCitation();
    fs.rmSync(metadataPath());
    const pdf = path.join(h.projectPath, 'PDFs', '2023_-_Documents_sauvegardés.pdf');

    const result = await updateAttachment({ ...citation, dateModified: null } as unknown as Citation, 'QQBJJVQY', pdf);

    expect(result).toMatchObject({ success: true });
    expect(attachmentsOnDisk()).toEqual([
      expect.objectContaining({ key: 'QQBJJVQY', downloaded: true, localPath: kept(pdf) }),
      expect.objectContaining({ key: 'GC9BPFL6', downloaded: false }),
    ]);
  });

  it('témoin : une clé de pièce jointe hostile reste refusée par le schéma', async () => {
    const citation = await panelCitation();

    await expect(updateAttachment(citation, '../../evil', path.join(h.projectPath, 'PDFs', 'x.pdf'))).rejects.toThrow(
      /attachmentKey: Attachment key must be a Zotero key/
    );
  });
});

/**
 * Le chemin rattaché se range relatif au projet (S07-2-1) : il ne peut donc désigner qu'un PDF de
 * `PDFs/`, où le téléchargement Zotero les écrit. Le main ne le vérifiait pas : n'importe quel
 * fichier du disque pouvait devenir le « PDF téléchargé » d'une référence.
 */
describe('bibliography:update-attachment — le PDF rattaché est dans PDFs/ du projet', () => {
  it('le chemin rangé est relatif au projet', async () => {
    const citation = await panelCitation();

    await updateAttachment(citation, 'QQBJJVQY', path.join(h.projectPath, 'PDFs', '2023_-_Documents_sauvegardés.pdf'));

    expect(attachmentsOnDisk()[0]).toMatchObject({ downloaded: true, localPath: 'PDFs/2023_-_Documents_sauvegardés.pdf' });
  });

  it.each([
    ['hors du projet', () => path.join(os.tmpdir(), 'ailleurs.pdf')],
    ['à la racine du projet', () => path.join(h.projectPath, 'a.pdf')],
    ['qui ressort de PDFs/ par « .. »', () => `${h.projectPath}/PDFs/../../a.pdf`],
    ['dans un dossier voisin au nom prolongé', () => `${h.projectPath}-2026/PDFs/a.pdf`],
  ])('un PDF %s est refusé, et rien n’est écrit', async (_where, localPath) => {
    const citation = await panelCitation();
    const before = fs.readFileSync(metadataPath(), 'utf8');

    const result = await updateAttachment(citation, 'QQBJJVQY', localPath());

    expect(result).toMatchObject({ success: false, code: 'attachment-outside-pdfs' });
    expect(fs.readFileSync(metadataPath(), 'utf8')).toBe(before);
  });
});
