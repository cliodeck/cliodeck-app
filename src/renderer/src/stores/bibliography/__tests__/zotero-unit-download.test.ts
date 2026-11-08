/**
 * @vitest-environment jsdom
 *
 * Deux téléchargements Zotero à l'unité en même temps (S07-1-5).
 *
 * `downloadAndIndexZoteroPDF` prenait la liste des références avant ses attentes (configuration,
 * téléchargement), puis la remettait dans le store et la faisait écrire en entier dans
 * `bibliography-metadata.json`. X lancé, puis Y ; Y finit d'abord, puis X : la liste de X, prise
 * avant que Y ne soit rattaché, effaçait Y, en mémoire comme sur le disque. Au lancement suivant, Y
 * n'avait plus de PDF alors que le fichier était dans `PDFs/` et indexé.
 *
 * Un rattachement que le main n'écrit pas (métadonnées illisibles) se dit : le PDF est dans
 * `PDFs/` sans être rattaché, et n'est pas indexé.
 *
 * Vrai store, vrai `BibliographyMetadataService` sur un projet temporaire. Le main est simulé :
 * `updateAttachment` appelle le vrai service, comme le handler. Zotero aussi : aucun appel à l'API
 * ni à une base Zotero, le téléchargement écrit un faux PDF, et chaque transfert attend qu'on le
 * relâche. Aucun délai : l'ordre est forcé par des promesses.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { useBibliographyStore } from '../../bibliographyStore';
import { useProjectStore } from '../../projectStore';
import { AttachmentNotSavedError } from '../zoteroSlice';
import type { Citation } from '../types';
import { BibliographyMetadataService, MetadataUnreadableError } from '../../../../../../backend/services/BibliographyMetadataService';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-telechargement-unitaire-'));
let project = '';

const reference = (id: string, zoteroKey: string, attachmentKey: string): Citation => ({
  id,
  type: 'article',
  author: 'Alpha, A.',
  year: '2023',
  title: `Article ${id}`,
  zoteroKey,
  zoteroAttachments: [
    { key: attachmentKey, filename: '2023 - Documents sauvegardés.pdf', contentType: 'application/pdf', downloaded: false },
  ],
});
const X = reference('guerre_2023', 'XKEY2023', 'QQBJJVQY');
const Y = reference('revue_2023', 'YKEY2023', 'GC9BPFL6');
const Z = reference('carnet_2023', 'ZKEY2023', 'ZZZZZZZ1');

/** Un transfert en cours : sa fin attend qu'on la relâche. */
interface HeldDownload {
  attachmentKey: string;
  release: () => void;
}
let held: HeldDownload[] = [];
let arrived: () => void = () => undefined;
/** Sans attente, un transfert répond aussitôt. */
let holdDownloads = false;
let updateAttachment: ReturnType<typeof vi.fn>;
let pdfIndex: ReturnType<typeof vi.fn>;

async function downloadsStarted(count: number): Promise<void> {
  while (held.length < count) {
    await new Promise<void>((resolve) => {
      arrived = resolve;
    });
  }
}

const pdfOf = (attachmentKey: string) => path.join(project, 'PDFs', `${attachmentKey}.pdf`);

function installMain(): void {
  updateAttachment = vi.fn(
    async (options: { projectPath: string; citation: Citation; attachmentKey: string; localPath: string }) => {
      try {
        await BibliographyMetadataService.patchAttachment(options.projectPath, options.citation as never, options.attachmentKey, options.localPath);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return error instanceof MetadataUnreadableError ? { success: false, error: message, code: error.code } : { success: false, error: message };
      }
    }
  );
  pdfIndex = vi.fn(async () => ({ success: true }));
  (window as unknown as { electron: unknown }).electron = {
    config: { get: vi.fn(async () => ({ mode: 'local', dataDirectory: '/zotero-simule' })) },
    project: { getConfig: vi.fn(async () => ({})) },
    zotero: {
      downloadPDF: vi.fn(async (options: { attachmentKey: string; targetDirectory: string }) => {
        if (holdDownloads) {
          let release: () => void = () => undefined;
          const done = new Promise<void>((resolve) => {
            release = resolve;
          });
          held.push({ attachmentKey: options.attachmentKey, release });
          arrived();
          await done;
        }
        const filePath = path.join(options.targetDirectory, 'PDFs', `${options.attachmentKey}.pdf`);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `%PDF-1.4 ${options.attachmentKey}`);
        return { success: true, filePath };
      }),
    },
    pdf: { index: pdfIndex },
    bibliography: { updateAttachment },
  };
}

const bib = () => useBibliographyStore.getState();
const inStore = (id: string) => bib().citations.find((c) => c.id === id);
const onDisk = async (zoteroKey: string) =>
  (await BibliographyMetadataService.loadMetadata(project))?.citations[zoteroKey]?.zoteroAttachments ?? [];
const damageMetadata = () => {
  const file = BibliographyMetadataService.getMetadataPath(project);
  const damaged = fs.readFileSync(file, 'utf-8').slice(0, 40);
  fs.writeFileSync(file, damaged);
  return damaged;
};

beforeEach(async () => {
  project = path.join(root, `p-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(project, { recursive: true });
  // Ce que la dernière synchronisation a laissé : X, Y et Z, aucun PDF téléchargé.
  await BibliographyMetadataService.saveFromSync(project, [X, Y, Z] as never);
  held = [];
  holdDownloads = false;
  installMain();
  useBibliographyStore.setState({
    citations: [X, Y, Z],
    filteredCitations: [X, Y, Z],
    indexedFilePaths: new Set(),
    indexedBibtexKeys: new Set(),
  });
  useProjectStore.setState({
    currentProject: { id: 'p', name: 'Projet', path: project, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
    loadState: { kind: 'idle' },
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('« Télécharger et indexer » un PDF Zotero : deux fiches en même temps', () => {
  it('X lancé puis Y, Y fini d’abord : les deux gardent leur PDF, dans le panneau et sur le disque', async () => {
    holdDownloads = true;
    const x = bib().downloadAndIndexZoteroPDF(X.id, 'QQBJJVQY', project);
    await downloadsStarted(1);
    const y = bib().downloadAndIndexZoteroPDF(Y.id, 'GC9BPFL6', project);
    await downloadsStarted(2);

    held[1].release();
    expect(await y).toEqual({});
    held[0].release();
    expect(await x).toEqual({});

    expect(inStore(X.id)?.file).toBe(pdfOf('QQBJJVQY'));
    expect(inStore(Y.id)?.file).toBe(pdfOf('GC9BPFL6'));
    expect(await onDisk('XKEY2023')).toEqual([expect.objectContaining({ downloaded: true, localPath: pdfOf('QQBJJVQY') })]);
    expect(await onDisk('YKEY2023')).toEqual([expect.objectContaining({ downloaded: true, localPath: pdfOf('GC9BPFL6') })]);
    // Au lancement suivant : les deux références retrouvent leur PDF.
    const reloaded = BibliographyMetadataService.mergeCitationsWithMetadata(
      [X, Y].map(({ zoteroAttachments: _dropped, ...fromBib }) => fromBib) as never,
      await BibliographyMetadataService.loadMetadata(project)
    );
    expect(reloaded.map((c) => c.file)).toEqual([pdfOf('QQBJJVQY'), pdfOf('GC9BPFL6')]);
  });

  it('seul le rattachement part au main, jamais la liste entière', async () => {
    await bib().downloadAndIndexZoteroPDF(X.id, 'QQBJJVQY', project);

    expect(updateAttachment).toHaveBeenCalledTimes(1);
    expect(updateAttachment.mock.calls[0][0]).toMatchObject({
      projectPath: project,
      citation: { id: X.id, zoteroKey: 'XKEY2023' },
      attachmentKey: 'QQBJJVQY',
      localPath: pdfOf('QQBJJVQY'),
    });
    expect(updateAttachment.mock.calls[0][0].citation).not.toHaveProperty('title');
  });
});

describe('un PDF téléchargé que le main ne rattache pas', () => {
  it('métadonnées illisibles : l’erreur le dit, le PDF reste dans PDFs/, rien n’est indexé ni écrit', async () => {
    const damaged = damageMetadata();

    const error = await bib()
      .downloadAndIndexZoteroPDF(X.id, 'QQBJJVQY', project)
      .then(
        () => null,
        (e: unknown) => e
      );

    expect(error).toBeInstanceOf(AttachmentNotSavedError);
    expect((error as AttachmentNotSavedError).notAttached).toMatchObject({
      title: X.title,
      filePath: pdfOf('QQBJJVQY'),
      metadataUnreadable: true,
    });
    expect(fs.existsSync(pdfOf('QQBJJVQY'))).toBe(true);
    expect(pdfIndex).not.toHaveBeenCalled();
    // Le panneau ne montre pas un rattachement qui n'existe pas.
    expect(inStore(X.id)?.file).toBeUndefined();
    expect(fs.readFileSync(BibliographyMetadataService.getMetadataPath(project), 'utf-8')).toBe(damaged);
  });

  it('autre échec : l’erreur dit lequel, et rien n’est indexé', async () => {
    updateAttachment.mockResolvedValueOnce({ success: false, error: 'EACCES: permission denied' });

    const error = await bib()
      .downloadAndIndexZoteroPDF(X.id, 'QQBJJVQY', project)
      .then(
        () => null,
        (e: unknown) => e
      );

    expect((error as AttachmentNotSavedError).notAttached).toMatchObject({
      metadataUnreadable: false,
      detail: 'EACCES: permission denied',
    });
    expect(pdfIndex).not.toHaveBeenCalled();
    expect(inStore(X.id)?.file).toBeUndefined();
  });
});

describe('deux notices Zotero de même clé BibTeX (jumeaux Better BibTeX)', () => {
  // Deux entrées du journal de Lester exportées sous la même clé : seules leurs clés Zotero et
  // leurs pièces jointes les distinguent, et `bibliography-metadata.json` les range sous leur clé
  // Zotero. Chercher la référence par sa seule clé BibTeX rendait toujours la première.
  const twin = (zoteroKey: string, attachmentKey: string): Citation => ({
    ...reference('Lester_1935', zoteroKey, attachmentKey),
    title: `Diary ${zoteroKey}`,
  });
  const A = twin('ZKA', 'ATTA');
  const B = twin('ZKB', 'ATTB');
  const twinInStore = (zoteroKey: string) => bib().citations.find((c) => c.zoteroKey === zoteroKey);

  beforeEach(async () => {
    await BibliographyMetadataService.saveFromSync(project, [A, B] as never);
    useBibliographyStore.setState({ citations: [A, B], filteredCitations: [A, B] });
  });

  async function expectEachAttachedToItsOwn(): Promise<void> {
    expect(await onDisk('ZKA')).toEqual([expect.objectContaining({ key: 'ATTA', downloaded: true, localPath: pdfOf('ATTA') })]);
    expect(await onDisk('ZKB')).toEqual([expect.objectContaining({ key: 'ATTB', downloaded: true, localPath: pdfOf('ATTB') })]);
    // Au lancement suivant, chacune retrouve son PDF.
    const reloaded = BibliographyMetadataService.mergeCitationsWithMetadata(
      [A, B].map(({ zoteroAttachments: _dropped, ...fromBib }) => fromBib) as never,
      await BibliographyMetadataService.loadMetadata(project)
    );
    expect(reloaded.map((c) => c.file)).toEqual([pdfOf('ATTA'), pdfOf('ATTB')]);
  }

  it('le lot rattache le PDF de la seconde à la seconde, pas à la première', async () => {
    const result = await bib().downloadAllMissingPDFs(project);

    expect(result).toMatchObject({ downloaded: 2, errors: [] });
    expect(updateAttachment.mock.calls.map((call) => [call[0].citation.zoteroKey, call[0].attachmentKey])).toEqual([
      ['ZKA', 'ATTA'],
      ['ZKB', 'ATTB'],
    ]);
    await expectEachAttachedToItsOwn();
    // Le panneau aussi : la première ne prend pas le PDF de la seconde.
    expect(twinInStore('ZKA')?.file).toBe(pdfOf('ATTA'));
    expect(twinInStore('ZKB')?.file).toBe(pdfOf('ATTB'));
    expect(twinInStore('ZKA')?.zoteroAttachments).toEqual([expect.objectContaining({ key: 'ATTA', downloaded: true })]);
  });

  it('à l’unité, la fiche de la seconde télécharge et rattache son propre PDF', async () => {
    expect(await bib().downloadAndIndexZoteroPDF('Lester_1935', 'ATTB', project)).toEqual({});

    expect(updateAttachment.mock.calls[0][0]).toMatchObject({ citation: { zoteroKey: 'ZKB' }, attachmentKey: 'ATTB' });
    expect(await onDisk('ZKB')).toEqual([expect.objectContaining({ downloaded: true, localPath: pdfOf('ATTB') })]);
    expect(await onDisk('ZKA')).toEqual([expect.objectContaining({ downloaded: false })]);
    expect(twinInStore('ZKB')?.file).toBe(pdfOf('ATTB'));
    expect(twinInStore('ZKA')?.file).toBeUndefined();

    expect(await bib().downloadAndIndexZoteroPDF('Lester_1935', 'ATTA', project)).toEqual({});
    await expectEachAttachedToItsOwn();
    expect(twinInStore('ZKA')?.file).toBe(pdfOf('ATTA'));
    expect(twinInStore('ZKB')?.file).toBe(pdfOf('ATTB'));
  });
});

describe('« Télécharger tous les PDFs manquants » : un rattachement refusé', () => {
  it('métadonnées illisibles : le lot s’arrête au premier PDF et le dit, sans rien indexer', async () => {
    const damaged = damageMetadata();

    const result = await bib().downloadAllMissingPDFs(project);

    expect(result).toMatchObject({
      downloaded: 0,
      errors: [],
      remaining: 2,
      stopped: { title: X.title, filePath: pdfOf('QQBJJVQY'), metadataUnreadable: true },
    });
    expect(updateAttachment).toHaveBeenCalledTimes(1);
    expect(pdfIndex).not.toHaveBeenCalled();
    expect(fs.existsSync(pdfOf('GC9BPFL6'))).toBe(false);
    expect(fs.readFileSync(BibliographyMetadataService.getMetadataPath(project), 'utf-8')).toBe(damaged);
    expect(bib().batchIndexing.isIndexing).toBe(false);
  });

  it('autre échec : une erreur nommée pour cette référence, pas un succès, et le lot continue', async () => {
    updateAttachment.mockResolvedValueOnce({ success: false, error: 'EACCES: permission denied' });

    const result = await bib().downloadAllMissingPDFs(project);

    expect(result.downloaded).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(X.title);
    expect(result.errors[0]).toContain('EACCES: permission denied');
    expect(result.stopped).toBeUndefined();
    expect(pdfIndex.mock.calls.map((call) => call[0])).toEqual([pdfOf('GC9BPFL6'), pdfOf('ZZZZZZZ1')]);
    expect(inStore(X.id)?.file).toBeUndefined();
    expect(await onDisk('YKEY2023')).toEqual([expect.objectContaining({ downloaded: true })]);
  });
});
