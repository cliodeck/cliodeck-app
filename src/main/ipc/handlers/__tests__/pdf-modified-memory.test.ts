/**
 * Le projet retient les PDF modifiés auxquels l'historien a répondu (Q22).
 *
 * Zotero garde le MD5 du fichier qu'il connaît : un PDF annoté dans le projet en diffère pour
 * toujours, réindexé ou pas. Sans mémoire, le bandeau « PDF modifiés » le signalait de nouveau à
 * chaque vérification, toutes les cinq minutes. Réindexé ou ignoré, le PDF est désormais retenu
 * avec son MD5 dans `bibliography-metadata.json`, par pièce jointe (`signaledMd5`), sous le verrou
 * du fichier ; il revient s'il change encore. Le MD5 de Zotero n'est jamais réécrit, et la mémoire
 * survit à une synchronisation, qui reconstruit les pièces jointes.
 *
 * Vrais handlers (`pdf:check-modified-pdfs`, `pdf:remember-modified-pdfs`,
 * `bibliography:load-with-metadata`), vrai détecteur, vrai service de métadonnées, sur un projet
 * temporaire. Sont simulés le projet ouvert du main (une variable) et les services d'indexation,
 * que ces canaux n'appellent pas.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

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
vi.mock('../../../services/pdf-service.js', () => ({
  pdfService: { indexPDF: vi.fn(), getVectorStore: () => null },
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
const { BibliographyMetadataService } = await import('../../../../../backend/services/BibliographyMetadataService.js');
setupPDFHandlers();
setupBibliographyHandlers();

interface ModifiedPDF {
  citationId: string;
  zoteroKey?: string;
  attachmentKey: string;
  newMD5?: string;
}
interface Response {
  success: boolean;
  error?: string;
  citations?: Array<Record<string, unknown>>;
  modifiedPDFs?: ModifiedPDF[];
}

async function call(channel: string, ...args: unknown[]): Promise<Response> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Aucun handler pour ${channel}`);
  return (await handler({ sender: {} }, ...args)) as Response;
}

const md5 = (content: string): string => createHash('md5').update(content).digest('hex');
const ZOTERO_BYTES = '%PDF-1.4 version de Zotero';
const ANNOTATED_BYTES = '%PDF-1.4 version annotée dans Aperçu';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-pdf-modifies-memoire-'));
let P = '';
let pdf = '';
let bib = '';

/** La pièce jointe telle que la synchronisation Zotero la rapporte : le MD5 du fichier de Zotero. */
const fromZotero = () => ({
  key: 'ATT1',
  filename: 'Vaswani et al. - 2017.pdf',
  contentType: 'application/pdf',
  downloaded: false,
  md5: md5(ZOTERO_BYTES),
});

/** Les références comme le panneau les tient : relues du `.bib` et des métadonnées. */
async function loadCitations(): Promise<Array<Record<string, unknown>>> {
  const loaded = await call('bibliography:load-with-metadata', { filePath: bib, projectPath: P });
  expect(loaded.success).toBe(true);
  return loaded.citations ?? [];
}

const check = async (citations: Array<Record<string, unknown>>) => {
  const result = await call('pdf:check-modified-pdfs', { citations, projectPath: P });
  expect(result.success).toBe(true);
  return result.modifiedPDFs ?? [];
};

/** Ce que le panneau renvoie quand l'historien a répondu : réindexé, ou ignoré. */
const answer = (modified: ModifiedPDF[], projectPath = P) =>
  call('pdf:remember-modified-pdfs', {
    projectPath,
    pdfs: modified.map((m) => ({
      citationId: m.citationId,
      zoteroKey: m.zoteroKey,
      attachmentKey: m.attachmentKey,
      md5: m.newMD5,
    })),
  });

const storedAttachment = () =>
  JSON.parse(fs.readFileSync(BibliographyMetadataService.getMetadataPath(P), 'utf-8')).citations.Z1.zoteroAttachments[0];

beforeEach(async () => {
  P = path.join(root, `projet-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(P, 'PDFs'), { recursive: true });
  fs.writeFileSync(path.join(P, 'project.json'), JSON.stringify({ name: 'Projet', type: 'article' }));
  bib = path.join(P, 'references.bib');
  fs.writeFileSync(
    bib,
    '@article{Vaswani_2017,\n  author = {Vaswani, Ashish},\n  title = {Attention Is All You Need},\n  year = {2017},\n  zoterokey = {Z1}\n}\n'
  );
  // Téléchargé depuis Zotero, puis annoté dans le projet.
  pdf = path.join(P, 'PDFs', 'ATT1.pdf');
  fs.writeFileSync(pdf, ANNOTATED_BYTES);
  await BibliographyMetadataService.saveFromSync(P, [
    { id: 'Vaswani_2017', zoteroKey: 'Z1', zoteroAttachments: [{ ...fromZotero(), downloaded: true, localPath: pdf }] },
  ] as never);
  current = P;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('PDF modifiés — la mémoire du projet', () => {
  it('signalé, puis réindexé ou ignoré : plus signalé à la vérification suivante ; modifié de nouveau : signalé', async () => {
    const citations = await loadCitations();
    const first = await check(citations);
    expect(first).toEqual([expect.objectContaining({ attachmentKey: 'ATT1', zoteroKey: 'Z1', newMD5: md5(ANNOTATED_BYTES) })]);

    expect(await answer(first)).toMatchObject({ success: true });

    // La liste du panneau, prise avant la réponse, comme celle relue du disque.
    expect(await check(citations)).toEqual([]);
    expect(await check(await loadCitations())).toEqual([]);

    fs.writeFileSync(pdf, `${ANNOTATED_BYTES}, puis une seconde annotation`);
    expect((await check(citations)).map((m) => m.newMD5)).toEqual([md5(`${ANNOTATED_BYTES}, puis une seconde annotation`)]);
  });

  it('le MD5 de Zotero n’est pas réécrit : seule la mémoire change', async () => {
    await answer(await check(await loadCitations()));

    expect(storedAttachment()).toMatchObject({ md5: md5(ZOTERO_BYTES), signaledMd5: md5(ANNOTATED_BYTES) });
  });

  it('la mémoire survit à une synchronisation Zotero, qui reconstruit les pièces jointes', async () => {
    await answer(await check(await loadCitations()));

    await BibliographyMetadataService.saveFromSync(P, [
      { id: 'Vaswani_2017', zoteroKey: 'Z1', zoteroAttachments: [fromZotero()] },
    ] as never);

    expect(storedAttachment()).toMatchObject({ signaledMd5: md5(ANNOTATED_BYTES), downloaded: true });
    expect(await check(await loadCitations())).toEqual([]);
  });

  it('elle survit aussi à un nouveau rattachement de la pièce jointe', async () => {
    await answer(await check(await loadCitations()));

    await BibliographyMetadataService.patchAttachment(
      P,
      { id: 'Vaswani_2017', zoteroKey: 'Z1', zoteroAttachments: [fromZotero()] },
      'ATT1',
      pdf
    );

    expect(storedAttachment()).toMatchObject({ signaledMd5: md5(ANNOTATED_BYTES) });
  });

  it('un autre projet ouvert entre-temps : refusé, rien n’est écrit', async () => {
    const modified = await check(await loadCitations());
    const before = fs.readFileSync(BibliographyMetadataService.getMetadataPath(P), 'utf-8');
    current = path.join(root, 'un-autre-projet');

    expect(await answer(modified)).toMatchObject({ success: false, error: 'project-changed' });
    expect(fs.readFileSync(BibliographyMetadataService.getMetadataPath(P), 'utf-8')).toBe(before);
  });
});
