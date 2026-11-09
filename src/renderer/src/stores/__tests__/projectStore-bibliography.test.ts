/**
 * @vitest-environment jsdom
 *
 * Le `.bib` attendu d'un projet ne se lit pas : le panneau le dit, pour ce projet-là (S07-1-11).
 *
 * Un échec de `loadBibliographyWithMetadata` à l'ouverture n'était qu'inscrit au journal, et le
 * store gardait les références du projet précédent : B, dont le `.bib` avait été renommé hors de
 * l'app, montrait la liste de A. Et rien ne disait que le fichier manquait.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useProjectStore } from '../projectStore';
import { useEditorStore } from '../editorStore';
import { useBibliographyStore } from '../bibliographyStore';

const project = (name: string, bib?: string) => ({
  id: name,
  name,
  path: `/tmp/${name}`,
  type: 'article' as const,
  createdAt: new Date('2026-01-01').toISOString(),
  lastOpenedAt: new Date('2026-01-02').toISOString(),
  ...(bib ? { bibliographySource: { type: 'file', filePath: bib } } : {}),
});

const A1 = { id: 'Alpha_2022', type: 'article', author: 'Alpha', year: '2022', title: 'Article A1' };

let originalElectron: unknown;
let projects: Record<string, ReturnType<typeof project>>;
let loadWithMetadata: ReturnType<typeof vi.fn>;

async function open(name: string): Promise<void> {
  await useProjectStore.getState().loadProject(`/tmp/${name}`);
  expect(useProjectStore.getState().loadState.kind).toBe('ready');
}

beforeEach(() => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  projects = {};
  loadWithMetadata = vi.fn();
  const byPath = (p: string) => projects[p.replace('/tmp/', '')];
  (window as unknown as { electron: unknown }).electron = {
    project: {
      load: vi.fn(async (p: string) => ({ success: true, project: byPath(p) })),
      getMetadata: vi.fn(async (p: string) => ({ success: true, project: byPath(p) })),
      getRecent: vi.fn().mockResolvedValue([]),
      getChapters: vi.fn().mockResolvedValue({ success: true, chapters: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    },
    editor: { loadFile: vi.fn().mockResolvedValue({ success: true, content: '# Texte\n' }) },
    fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
    pdf: { getAll: vi.fn().mockResolvedValue({ success: true, documents: [] }) },
    bibliography: {
      loadWithMetadata,
      readingNotes: { list: vi.fn().mockResolvedValue({ success: true, notes: [] }) },
    },
  };
  useEditorStore.setState({ filePath: null, content: '', isDirty: false, editorFacade: null, bufferDetached: false });
  useProjectStore.setState({ currentProject: null, chapters: [], currentChapterId: null, loadState: { kind: 'idle' }, recentProjects: [] });
  useBibliographyStore.setState({
    citations: [],
    filteredCitations: [],
    bibliographyProblem: null,
    readingNotes: [],
    indexedFilePaths: new Set<string>(),
    indexedBibtexKeys: new Set<string>(),
  } as never);
});

afterEach(() => {
  (window as unknown as { electron?: unknown }).electron = originalElectron;
});

describe('ouvrir B après A', () => {
  it('le .bib attendu de B est introuvable : le bandeau de B, pas la liste de A', async () => {
    projects = { A: project('A', 'a.bib'), B: project('B', 'renomme.bib') };
    loadWithMetadata
      .mockResolvedValueOnce({ success: true, citations: [A1], unreadKeys: [], metadataUnreadable: false })
      .mockResolvedValueOnce({ success: false, error: 'introuvable', citations: [], problem: 'missing' });

    await open('A');
    expect(useBibliographyStore.getState().citations.map((c) => c.id)).toEqual(['Alpha_2022']);
    await open('B');

    expect(loadWithMetadata).toHaveBeenLastCalledWith({ filePath: '/tmp/B/renomme.bib', projectPath: '/tmp/B' });
    expect(useBibliographyStore.getState().citations).toEqual([]);
    expect(useBibliographyStore.getState().filteredCitations).toEqual([]);
    expect(useBibliographyStore.getState().bibliographyProblem).toEqual({ kind: 'missing', file: 'renomme.bib' });
  });

  it('le .bib de B n’est pas en UTF-8 : le bandeau le dit', async () => {
    projects = { B: project('B', 'latin1.bib') };
    loadWithMetadata.mockResolvedValueOnce({
      success: false,
      error: 'pas UTF-8',
      citations: [],
      problem: 'unreadable',
      reason: 'encoding',
    });

    await open('B');

    expect(useBibliographyStore.getState().bibliographyProblem).toEqual({
      kind: 'unreadable',
      file: 'latin1.bib',
      reason: 'encoding',
      detail: 'pas UTF-8',
    });
  });

  it('un bandeau de A ne s’affiche jamais dans B, même sans bibliographie configurée', async () => {
    projects = { A: project('A', 'renomme.bib'), B: project('B') };
    loadWithMetadata.mockResolvedValueOnce({ success: false, error: 'introuvable', citations: [], problem: 'missing' });

    await open('A');
    expect(useBibliographyStore.getState().bibliographyProblem).toEqual({ kind: 'missing', file: 'renomme.bib' });
    await open('B');

    expect(loadWithMetadata).toHaveBeenCalledTimes(1);
    expect(useBibliographyStore.getState().bibliographyProblem).toBeNull();
  });

  it('B n’a pas de bibliographie configurée : ni la liste de A', async () => {
    // La branche sans bibliographie ne remettait que le bandeau à zéro : le panneau de B montrait
    // les références de A, et la vérification des PDF modifiés les prenait pour celles de B (Q22).
    projects = { A: project('A', 'a.bib'), B: project('B') };
    loadWithMetadata.mockResolvedValueOnce({ success: true, citations: [A1], unreadKeys: [], metadataUnreadable: false });

    await open('A');
    expect(useBibliographyStore.getState().citations.map((c) => c.id)).toEqual(['Alpha_2022']);
    await open('B');

    expect(loadWithMetadata).toHaveBeenCalledTimes(1);
    expect(useBibliographyStore.getState().citations).toEqual([]);
    expect(useBibliographyStore.getState().filteredCitations).toEqual([]);
  });

  it('B, créé après A, n’a pas encore de bibliographie : ni la liste de A', async () => {
    projects = { A: project('A', 'a.bib') };
    const electron = (window as unknown as { electron: { project: Record<string, unknown> } }).electron;
    electron.project.create = vi.fn(async ({ name }: { name: string }) => ({ success: true, project: project(name) }));
    loadWithMetadata.mockResolvedValueOnce({ success: true, citations: [A1], unreadKeys: [], metadataUnreadable: false });

    await open('A');
    expect(useBibliographyStore.getState().citations.map((c) => c.id)).toEqual(['Alpha_2022']);
    expect(await useProjectStore.getState().createProject('B', 'article', '/tmp')).toBe(true);

    expect(useProjectStore.getState().currentProject?.path).toBe('/tmp/B');
    expect(useBibliographyStore.getState().citations).toEqual([]);
    expect(useBibliographyStore.getState().filteredCitations).toEqual([]);
  });

  it('des entrées non lues et des métadonnées illisibles : la liste s’affiche, le bandeau aussi', async () => {
    projects = { B: project('B', 'b.bib') };
    loadWithMetadata.mockResolvedValueOnce({
      success: true,
      citations: [A1],
      unreadKeys: ['entretien_dupont'],
      metadataUnreadable: true,
    });

    await open('B');

    expect(useBibliographyStore.getState().citations.map((c) => c.id)).toEqual(['Alpha_2022']);
    expect(useBibliographyStore.getState().bibliographyProblem).toEqual({
      kind: 'partial',
      file: 'b.bib',
      unreadKeys: ['entretien_dupont'],
      metadataUnreadable: true,
    });
  });

  it('le .bib de B ne se lit pas : les notes de lecture et les PDF indexés de B sont relus quand même', async () => {
    // Sur `main`, ce fichier rendait une liste vide « réussie », et la suite de l'ouverture relisait
    // les notes et les PDF du nouveau projet. La branche d'échec les sautait : les étiquettes de A
    // restaient affichées dans B, et une étiquette ajoutée dans B y recopiait celles de A.
    projects = { A: project('A', 'a.bib'), B: project('B', 'renomme.bib') };
    const electron = (window as unknown as {
      electron: {
        bibliography: { readingNotes: { list: ReturnType<typeof vi.fn> } };
        pdf: { getAll: ReturnType<typeof vi.fn> };
      };
    }).electron;
    const listNotes = electron.bibliography.readingNotes.list;
    const getAll = electron.pdf.getAll;
    listNotes
      .mockResolvedValueOnce({
        success: true,
        notes: [{ file: 'reading-notes/Alpha_2022.md', citekey: 'Alpha_2022', tags: ['etiquette-de-A'] }],
      })
      .mockResolvedValueOnce({ success: true, notes: [] });
    // Un document indexé, avec ses extraits, comme le rend `VectorStore.getAllDocuments`.
    const indexedInA = { fileURL: '/tmp/A/PDFs/a.pdf', bibtexKey: 'Alpha_2022', chunkCount: 4 };
    getAll
      .mockResolvedValueOnce({ success: true, documents: [indexedInA] })
      .mockResolvedValueOnce({ success: true, documents: [indexedInA] })
      .mockResolvedValue({ success: true, documents: [] });
    loadWithMetadata
      .mockResolvedValueOnce({ success: true, citations: [A1], unreadKeys: [], metadataUnreadable: false })
      .mockResolvedValueOnce({ success: false, error: 'introuvable', citations: [], problem: 'missing' });

    await open('A');
    await vi.waitFor(() => {
      expect(useBibliographyStore.getState().readingNotes.map((n) => n.citekey)).toEqual(['Alpha_2022']);
    });
    expect([...useBibliographyStore.getState().indexedFilePaths]).toEqual(['/tmp/A/PDFs/a.pdf']);
    const notesCallsAfterA = listNotes.mock.calls.length;
    const pdfCallsAfterA = getAll.mock.calls.length;

    await open('B');

    expect(useBibliographyStore.getState().bibliographyProblem).toEqual({ kind: 'missing', file: 'renomme.bib' });
    expect(listNotes.mock.calls.length).toBeGreaterThan(notesCallsAfterA);
    expect(getAll.mock.calls.length).toBeGreaterThan(pdfCallsAfterA);
    await vi.waitFor(() => {
      expect(useBibliographyStore.getState().readingNotes).toEqual([]);
    });
    expect([...useBibliographyStore.getState().indexedFilePaths]).toEqual([]);
    expect(useBibliographyStore.getState().getAllTags()).toEqual([]);
  });

  it('témoin : le fichier redevient lisible, le bandeau disparaît', async () => {
    projects = { B: project('B', 'b.bib') };
    loadWithMetadata
      .mockResolvedValueOnce({ success: false, error: 'introuvable', citations: [], problem: 'missing' })
      .mockResolvedValueOnce({ success: true, citations: [A1], unreadKeys: [], metadataUnreadable: false });

    await open('B');
    await useBibliographyStore.getState().loadBibliographyWithMetadata('/tmp/B/b.bib', '/tmp/B');

    expect(useBibliographyStore.getState().bibliographyProblem).toBeNull();
    expect(useBibliographyStore.getState().citations.map((c) => c.id)).toEqual(['Alpha_2022']);
  });
});
