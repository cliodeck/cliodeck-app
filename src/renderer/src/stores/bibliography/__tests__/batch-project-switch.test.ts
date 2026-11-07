/**
 * @vitest-environment jsdom
 *
 * Un lot de PDF lancé dans A, et l'historien ouvre B avant la fin (S18-2-0).
 *
 * Les lots « Télécharger tous les PDFs manquants depuis Zotero » et « Indexer tous les PDFs »
 * durent des minutes, et rien ne les liait à leur projet. Après la bascule, le premier relisait
 * les références du store, celles de B, et les enregistrait comme métadonnées de A : A perdait
 * tous ses rattachements, y compris ceux d'avant le lot. Les deux envoyaient les PDF de A au
 * main, qui les indexait dans le corpus du projet courant, B.
 *
 * Vrai `loadProject`, vraie chaîne `loadBibliographyWithMetadata`, vrai `BibliographyMetadataService`
 * sur deux projets temporaires. Le main est simulé, sans ses propres gardes : un projet courant
 * que `project:load` change avant de répondre, et un corpus par projet. Zotero aussi : aucun appel
 * à l'API ni à une base Zotero, le téléchargement écrit un faux PDF.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { useProjectStore } from '../../projectStore';
import { useBibliographyStore } from '../../bibliographyStore';
import { useEditorStore } from '../../editorStore';
import { BibliographyMetadataService } from '../../../../../../backend/services/BibliographyMetadataService';
import { BibTeXParser } from '../../../../../../backend/core/bibliography/BibTeXParser';
import type { Citation } from '../types';

vi.setConfig({ testTimeout: 30_000 });

// --- Le main simulé -------------------------------------------------------------------------

interface IndexedDocument {
  id: string;
  fileURL: string;
  bibtexKey?: string;
}

/** Le projet ouvert dans le main : `project:load` le change avant de rendre la main. */
let mainCurrent: string | null = null;
/** Le corpus de chaque projet, tel que `pdf:index` le remplit. */
let corpus = new Map<string, IndexedDocument[]>();
/** Chaque `pdf:index` : le fichier, le projet où il a été indexé et le projet attendu. */
let indexCalls: Array<{ file: string; at: string | null; expected?: string }> = [];
let downloadCalls: Array<{ attachmentKey: string; targetDirectory: string }> = [];
let saveCalls: Array<{ projectPath: string; ids: string[] }> = [];

/** Une réponse du main qu'on rend quand on veut. */
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Une attente par appel, dans l'ordre : sans attente, l'appel répond aussitôt. */
let downloadGates: Array<Promise<void>> = [];
let indexGates: Array<Promise<void>> = [];
let getAllGates: Array<Promise<void>> = [];
/** Retient `project:load` après la bascule du main : l'écran montre encore A. */
let loadGate: Promise<void> | null = null;

const docsOf = (project: string | null): IndexedDocument[] => (project ? (corpus.get(project) ?? []) : []);

// --- Deux projets sur le disque -------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-lot-pdf-'));
let A = '';
let B = '';
let bHasBibliography = true;

const notice = (id: string, zoteroKey: string, extra = '') =>
  `@article{${id},\n  title = {Article ${id}},\n  author = {Alpha, A.},\n  year = {2020},\n  zoterokey = {${zoteroKey}}${extra}\n}\n`;

const attachment = (key: string, localPath?: string) => ({
  key,
  filename: `${key}.pdf`,
  contentType: 'application/pdf',
  downloaded: !!localPath,
  ...(localPath ? { localPath } : {}),
});

async function makeProjects(): Promise<void> {
  const id = Math.random().toString(36).slice(2, 8);
  A = path.join(root, `A-${id}`);
  B = path.join(root, `B-${id}`);
  for (const dir of [A, B]) fs.mkdirSync(path.join(dir, 'PDFs'), { recursive: true });

  // A : quatre notices Zotero. a0 a été téléchargée lors d'une session antérieure.
  fs.writeFileSync(
    path.join(A, 'bibliography.bib'),
    ['a0', 'a1', 'a2', 'a3'].map((c, i) => notice(c, `ZA${i}`)).join('\n')
  );
  const a0Pdf = path.join(A, 'PDFs', 'ATTA0.pdf');
  fs.writeFileSync(a0Pdf, '%PDF-1.4 a0');
  await BibliographyMetadataService.saveMetadata(
    A,
    ['a0', 'a1', 'a2', 'a3'].map((c, i) => ({
      id: c,
      zoteroKey: `ZA${i}`,
      zoteroAttachments: [attachment(`ATTA${i}`, i === 0 ? a0Pdf : undefined)],
      zoteroTags: [{ tag: `tag-${c}`, automatic: false }],
    })) as never
  );

  // B : sa propre notice Zotero, avec un PDF à télécharger.
  fs.writeFileSync(path.join(B, 'bibliography.bib'), notice('b1', 'ZB1'));
  await BibliographyMetadataService.saveMetadata(B, [
    { id: 'b1', zoteroKey: 'ZB1', zoteroAttachments: [attachment('ATTB1')] },
  ] as never);

  corpus = new Map([
    [A, [{ id: 'docA0', fileURL: a0Pdf, bibtexKey: 'a0' }]],
    [B, [{ id: 'docB1', fileURL: path.join(B, 'PDFs', 'b1.pdf'), bibtexKey: 'b1' }]],
  ]);
}

const projectData = (p: string) => ({
  id: path.basename(p),
  name: `Projet ${path.basename(p).slice(0, 1)}`,
  path: p,
  type: 'article',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-02T00:00:00.000Z',
  ...(p !== B || bHasBibliography ? { bibliographySource: { filePath: 'bibliography.bib' } } : {}),
});

const metadataFile = (project: string) => BibliographyMetadataService.getMetadataPath(project);
const readBytes = (file: string) => fs.readFileSync(file).toString('latin1');

function installMain(): void {
  (window as unknown as { electron: unknown }).electron = {
    config: { get: vi.fn(async () => ({ mode: 'local', dataDirectory: '/zotero-simule' })) },
    project: {
      getMetadata: vi.fn(async (p: string) => ({ success: true, project: projectData(p) })),
      load: vi.fn(async (p: string) => {
        mainCurrent = p;
        if (loadGate) await loadGate;
        return { success: true, project: projectData(p) };
      }),
      getRecent: vi.fn(async () => []),
      getConfig: vi.fn(async () => ({})),
    },
    editor: { loadFile: vi.fn(async () => ({ success: true, content: '# Document\n' })) },
    fs: { writeFile: vi.fn(async () => undefined) },
    bibliography: {
      // La chaîne du main : le .bib relu, puis les métadonnées du projet fusionnées.
      loadWithMetadata: vi.fn(async ({ filePath, projectPath }: { filePath: string; projectPath: string }) => {
        const citations = new BibTeXParser().parseFile(filePath);
        const metadata = await BibliographyMetadataService.loadMetadata(projectPath);
        return { success: true, citations: BibliographyMetadataService.mergeCitationsWithMetadata(citations, metadata) };
      }),
      saveMetadata: vi.fn(async ({ projectPath, citations }: { projectPath: string; citations: Citation[] }) => {
        saveCalls.push({ projectPath, ids: citations.map((c) => c.id) });
        await BibliographyMetadataService.saveMetadata(projectPath, citations as never);
        return { success: true };
      }),
      readingNotes: { list: vi.fn(async () => ({ success: true, notes: [] })) },
    },
    zotero: {
      downloadPDF: vi.fn(async (options: { attachmentKey: string; targetDirectory: string }) => {
        downloadCalls.push({ attachmentKey: options.attachmentKey, targetDirectory: options.targetDirectory });
        const gate = downloadGates.shift();
        if (gate) await gate;
        const filePath = path.join(options.targetDirectory, 'PDFs', `${options.attachmentKey}.pdf`);
        fs.writeFileSync(filePath, `%PDF-1.4 ${options.attachmentKey}`);
        return { success: true, filePath };
      }),
    },
    pdf: {
      index: vi.fn(async (file: string, bibtexKey?: string, _meta?: unknown, expected?: string) => {
        const at = mainCurrent;
        indexCalls.push({ file, at, expected });
        const gate = indexGates.shift();
        if (gate) await gate;
        if (at) corpus.set(at, [...docsOf(at), { id: `doc-${path.basename(file)}`, fileURL: file, bibtexKey }]);
        return { success: true, document: { id: `doc-${path.basename(file)}` } };
      }),
      getAll: vi.fn(async () => {
        const at = mainCurrent;
        const gate = getAllGates.shift();
        if (gate) await gate;
        return { success: true, documents: docsOf(at) };
      }),
      delete: vi.fn(async (id: string) => {
        if (mainCurrent) corpus.set(mainCurrent, docsOf(mainCurrent).filter((d) => d.id !== id));
        return { success: true };
      }),
    },
  };
}

/** Laisse passer les réponses déjà rendues. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(condition()).toBe(true);
}

const open = (p: string) => useProjectStore.getState().loadProject(p);
const bib = () => useBibliographyStore.getState();
const citation = (id: string) => bib().citations.find((c) => c.id === id);
const filesOf = (project: string) => docsOf(project).map((d) => d.fileURL);
const indexedIn = (project: string) => indexCalls.filter((c) => c.at === project).map((c) => c.file);

beforeEach(async () => {
  mainCurrent = null;
  indexCalls = [];
  downloadCalls = [];
  saveCalls = [];
  downloadGates = [];
  indexGates = [];
  getAllGates = [];
  loadGate = null;
  bHasBibliography = true;
  await makeProjects();
  installMain();
  useEditorStore.setState({ filePath: null, content: '', isDirty: false, editorFacade: null, bufferDetached: false });
  useProjectStore.setState({ currentProject: null, loadState: { kind: 'idle' }, recentProjects: [] });
  useBibliographyStore.setState({
    citations: [],
    filteredCitations: [],
    indexedFilePaths: new Set(),
    indexedBibtexKeys: new Set(),
  });
  await open(A);
  // Le point de départ : a0 rattachée à son PDF, les trois autres à télécharger.
  expect(citation('a0')?.file).toBe(path.join(A, 'PDFs', 'ATTA0.pdf'));
  indexCalls = [];
  saveCalls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('« Télécharger tous les PDFs manquants » : B ouvert pendant le premier téléchargement', () => {
  async function switchDuringFirstDownload() {
    const first = deferred();
    downloadGates = [first.promise];
    const metadataBefore = readBytes(metadataFile(A));
    const batch = bib().downloadAllMissingPDFs(A);
    await until(() => downloadCalls.length === 1);

    await open(B);
    first.resolve();
    const result = await batch;
    return { result, metadataBefore };
  }

  it('B a sa bibliographie : les métadonnées de A restent intactes, et rien de A n’entre dans B', async () => {
    const { result, metadataBefore } = await switchDuringFirstDownload();

    // Le fichier de A n'est pas réécrit avec les références de B, ni avec quoi que ce soit.
    expect(readBytes(metadataFile(A))).toBe(metadataBefore);
    expect(saveCalls).toEqual([]);
    expect(indexedIn(B)).toEqual([]);
    expect(filesOf(B).filter((f) => f.startsWith(A))).toEqual([]);
    expect(result).toMatchObject({ interrupted: true, downloaded: 0 });
    // Un seul téléchargement est parti, celui qui était en vol, et dans A.
    expect(downloadCalls).toEqual([{ attachmentKey: 'ATTA1', targetDirectory: A }]);
    // Le store est celui de B, et le lot ne montre plus de progression.
    expect(bib().citations.map((c) => c.id)).toEqual(['b1']);
    expect(bib().batchIndexing).toMatchObject({ isIndexing: false, current: 0, total: 0 });
  });

  it('B sans bibliographie : aucun PDF de A n’est indexé dans le corpus de B', async () => {
    bHasBibliography = false;
    const { result, metadataBefore } = await switchDuringFirstDownload();

    expect(indexedIn(B)).toEqual([]);
    expect(filesOf(B).filter((f) => f.startsWith(A))).toEqual([]);
    expect(readBytes(metadataFile(A))).toBe(metadataBefore);
    expect(result.interrupted).toBe(true);
    expect(bib().batchIndexing.isIndexing).toBe(false);
  });

  it('A rouvert garde ses rattachements, et relancer le lot termine le travail', async () => {
    await switchDuringFirstDownload();

    await open(A);
    // Le PDF téléchargé avant le lot est toujours rattaché, avec ses tags Zotero.
    expect(citation('a0')?.file).toBe(path.join(A, 'PDFs', 'ATTA0.pdf'));
    expect(citation('a0')?.zoteroTags).toEqual([{ tag: 'tag-a0', automatic: false }]);
    expect(citation('a1')?.file).toBeUndefined();

    const again = await bib().downloadAllMissingPDFs(A);

    expect(again).toMatchObject({ downloaded: 3, errors: [] });
    expect(again.interrupted).toBeUndefined();
    expect(['a0', 'a1', 'a2', 'a3'].map((c) => path.basename(citation(c)?.file ?? ''))).toEqual([
      'ATTA0.pdf',
      'ATTA1.pdf',
      'ATTA2.pdf',
      'ATTA3.pdf',
    ]);
    expect(indexedIn(A).map((f) => path.basename(f))).toEqual(['ATTA1.pdf', 'ATTA2.pdf', 'ATTA3.pdf']);
    expect(filesOf(B).filter((f) => f.startsWith(A))).toEqual([]);
  });

  it('le main a déjà pris B, l’écran montre encore A : le lot attend l’issue et s’arrête', async () => {
    const first = deferred();
    const opening = deferred();
    downloadGates = [first.promise];
    loadGate = opening.promise;
    const batch = bib().downloadAllMissingPDFs(A);
    await until(() => downloadCalls.length === 1);

    const switching = open(B);
    await until(() => mainCurrent === B);
    expect(useProjectStore.getState().currentProject?.path).toBe(A);
    first.resolve();
    await settle();

    // Rien n'est parti vers le main pendant l'ouverture, ni n'est écrit.
    expect(indexCalls).toEqual([]);
    expect(saveCalls).toEqual([]);

    opening.resolve();
    await switching;
    const result = await batch;

    expect(result.interrupted).toBe(true);
    expect(indexedIn(B)).toEqual([]);
    expect(saveCalls).toEqual([]);
  });

  it('témoin : sans changement de projet, le lot va au bout et dit au main pour quel projet il indexe', async () => {
    const result = await bib().downloadAllMissingPDFs(A);

    expect(result).toMatchObject({ downloaded: 3, errors: [] });
    expect(result.interrupted).toBeUndefined();
    expect(indexCalls.map((c) => c.expected)).toEqual([A, A, A]);
    expect(saveCalls.every((c) => c.projectPath === A)).toBe(true);
  });
});

describe('« Indexer tous les PDFs » : B ouvert pendant la première indexation', () => {
  beforeEach(async () => {
    // Trois notices dont le .bib porte le PDF.
    fs.writeFileSync(
      path.join(A, 'bibliography.bib'),
      ['x1', 'x2', 'x3'].map((c, i) => notice(c, `ZX${i}`, `,\n  file = {PDFs/${c}.pdf}`)).join('\n')
    );
    for (const c of ['x1', 'x2', 'x3']) fs.writeFileSync(path.join(A, 'PDFs', `${c}.pdf`), '%PDF-1.4');
    await open(A);
    indexCalls = [];
  });

  it('le PDF en vol reste dans A, les suivants ne partent pas, et B ne les compte pas comme indexés', async () => {
    const first = deferred();
    indexGates = [first.promise];
    const batch = bib().indexAllPDFs(A);
    await until(() => indexCalls.length === 1);

    await open(B);
    first.resolve();
    const result = await batch;

    expect(indexCalls.map((c) => c.at)).toEqual([A]);
    expect(bib().indexedFilePaths.has(path.join(A, 'PDFs', 'x1.pdf'))).toBe(false);
    expect(result.interrupted).toBe(true);
    expect(bib().batchIndexing).toMatchObject({ isIndexing: false, current: 0, total: 0 });
  });

  it('témoin : sans changement de projet, les trois PDF sont indexés dans A, projet attendu compris', async () => {
    const result = await bib().indexAllPDFs(A);

    expect(result).toMatchObject({ indexed: 3, errors: [] });
    expect(result.interrupted).toBeUndefined();
    expect(indexCalls.map((c) => [c.at, c.expected])).toEqual([
      [A, A],
      [A, A],
      [A, A],
    ]);
  });
});

describe('les gestes unitaires de la fiche ne finissent pas dans B', () => {
  it('« Télécharger et indexer » un PDF Zotero : ni les références de A dans le store de B, ni le PDF dans B', async () => {
    const first = deferred();
    downloadGates = [first.promise];
    const pending = bib().downloadAndIndexZoteroPDF('a1', 'ATTA1', A);
    await until(() => downloadCalls.length === 1);

    await open(B);
    first.resolve();
    const result = await pending;

    expect(bib().citations.map((c) => c.id)).toEqual(['b1']);
    expect(indexedIn(B)).toEqual([]);
    expect(result).toEqual({ interrupted: true });
  });

  it('« Indexer le PDF » : B ne compte pas comme indexé le PDF de A', async () => {
    // a0 n'est pas encore indexée dans A.
    corpus.set(A, []);
    useBibliographyStore.setState({ indexedFilePaths: new Set(), indexedBibtexKeys: new Set() });
    const first = deferred();
    indexGates = [first.promise];
    const pending = bib().indexPDFFromCitation('a0');
    await until(() => indexCalls.length === 1);

    await open(B);
    first.resolve();
    const result = await pending;

    expect(bib().indexedFilePaths.has(path.join(A, 'PDFs', 'ATTA0.pdf'))).toBe(false);
    expect(indexCalls[0]).toMatchObject({ at: A, expected: A });
    expect(result.interrupted).toBe(true);
  });

  it('« Ré-indexer » : le document de B de même clé n’est pas supprimé, et le PDF de A n’entre pas dans B', async () => {
    // a2 n'a pas de fichier : son chemin se retrouve dans l'index de A. B a sa propre notice a2.
    corpus.set(A, [...docsOf(A), { id: 'docA2', fileURL: path.join(A, 'PDFs', 'ATTA2.pdf'), bibtexKey: 'a2' }]);
    corpus.set(B, [...docsOf(B), { id: 'docB2', fileURL: path.join(B, 'PDFs', 'b-a2.pdf'), bibtexKey: 'a2' }]);
    const first = deferred();
    getAllGates = [first.promise];
    const pending = bib().reindexPDFFromCitation('a2');
    await until(() => getAllGates.length === 0);

    await open(B);
    first.resolve();
    const result = await pending;

    expect(docsOf(B).map((d) => d.id)).toEqual(['docB1', 'docB2']);
    expect(indexedIn(B)).toEqual([]);
    expect(result).toEqual({ interrupted: true });
  });
});
