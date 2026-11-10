/**
 * @vitest-environment jsdom
 *
 * Changer de projet repart de zéro, à l'écran comme dans les prompts (L03-4) : bibliographie,
 * conversation, sélection du panneau RAG. Le registre du projet est piloté par `projectStore` sur
 * tous ses chemins : ouvrir, créer, fermer, fermeture d'office, échec avec ou sans retour du projet
 * d'avant ; et le même projet rouvert ne perd rien.
 *
 * Un projet sans `.bib` montrait encore la bibliographie du précédent, ses étiquettes, sa recherche
 * et son filtre de tags (S07-1-31, repro de S15-1-5). La conversation de A repartait en historique
 * dans les tours de B (S16-1-22), et la sélection de documents de A filtrait la recherche de B
 * (S15-1-10).
 *
 * Vrais stores et registre, rechargés à chaque test ; seul le pont `window.electron` est simulé.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ProjectStoreModule = typeof import('../projectStore');
type BibliographyStoreModule = typeof import('../bibliographyStore');
type ChatStoreModule = typeof import('../chatStore');
type RagStoreModule = typeof import('../ragQueryStore');
type LifecycleModule = typeof import('../../lifecycle/projectLifecycle');

const project = (name: string, bib?: string) => ({
  id: name,
  name,
  path: `/tmp/${name}`,
  type: 'article' as const,
  createdAt: new Date('2026-01-01').toISOString(),
  lastOpenedAt: new Date('2026-01-02').toISOString(),
  ...(bib ? { bibliographySource: { type: 'file', filePath: bib } } : {}),
});

const CITATION_A = { id: 'Dupont_1990', type: 'book', author: 'Dupont', year: '1990', title: 'Le préfet et la grève' };
const NOTE_A = { file: 'reading-notes/Dupont_1990.md', citekey: 'Dupont_1990', tags: ['à relire'] };

let originalElectron: unknown;
let projects: Record<string, ReturnType<typeof project>>;
let loadResults: Record<string, unknown>;
let loadWithMetadata: ReturnType<typeof vi.fn>;
let listNotes: ReturnType<typeof vi.fn>;
let onClosed: ((closed: { path: string; code: string; error: string }) => void) | null;

let projects$: ProjectStoreModule;
let bibliography$: BibliographyStoreModule;
let chat$: ChatStoreModule;
let rag$: RagStoreModule;
let lifecycle$: LifecycleModule;

const byPath = (p: string) => projects[p.replace(/^\/tmp\//, '').replace(/\/project\.json$/, '')];

beforeEach(async () => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  projects = {};
  loadResults = {};
  onClosed = null;
  loadWithMetadata = vi.fn(async () => ({ success: true, citations: [CITATION_A], unreadKeys: [], metadataUnreadable: false }));
  listNotes = vi.fn(async () => ({ success: true, notes: [NOTE_A] }));
  (window as unknown as { electron: unknown }).electron = {
    project: {
      load: vi.fn(async (p: string) => loadResults[p] ?? { success: true, project: byPath(p) }),
      create: vi.fn(async ({ name }: { name: string }) => ({ success: true, project: project(name) })),
      getMetadata: vi.fn(async (p: string) => ({ success: true, project: byPath(p) })),
      getRecent: vi.fn(async () => []),
      getChapters: vi.fn(async () => ({ success: true, chapters: [] })),
      close: vi.fn(async () => undefined),
      onClosed: (cb: typeof onClosed) => {
        onClosed = cb;
        return () => undefined;
      },
      onRebuildProgress: () => () => undefined,
    },
    editor: { loadFile: vi.fn(async () => ({ success: true, content: '# Texte\n' })), saveFile: vi.fn() },
    fs: { writeFile: vi.fn(async () => undefined) },
    pdf: { getAll: vi.fn(async () => ({ success: true, documents: [] })) },
    config: { getAll: vi.fn(async () => ({ llm: {}, rag: {} })) },
    bibliography: { loadWithMetadata, readingNotes: { list: listNotes } },
  };
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  // Des modules neufs : le registre, et les abonnements que les stores prennent à leur chargement.
  vi.resetModules();
  projects$ = await import('../projectStore');
  bibliography$ = await import('../bibliographyStore');
  chat$ = await import('../chatStore');
  rag$ = await import('../ragQueryStore');
  lifecycle$ = await import('../../lifecycle/projectLifecycle');
});

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { electron?: unknown }).electron = originalElectron;
});

const store = () => projects$.useProjectStore.getState();
const bibliography = () => bibliography$.useBibliographyStore.getState();

async function open(name: string): Promise<void> {
  await store().loadProject(`/tmp/${name}/project.json`);
  expect(store().currentProject?.path).toBe(`/tmp/${name}`);
}

/** Le projet A tel que l'historien l'a laissé : bibliographie filtrée, conversation, sélection. */
async function openAWithEverything(): Promise<void> {
  projects.A = project('A', 'a.bib');
  await open('A');
  await vi.waitFor(() => expect(bibliography().readingNotes).toEqual([NOTE_A]));
  bibliography().searchCitations('préfet');
  bibliography().setTagsFilter(['à relire']);
  bibliography().selectCitation('Dupont_1990');
  chat$.useChatStore.getState().appendUser('Qui était le préfet en 1934 ?');
  rag$.useRAGQueryStore.getState().setSelectedDocuments(['doc-a']);
  rag$.useRAGQueryStore.getState().setSelectedCollections(['GUERRE']);
}

/** Rien de A : ni références, ni étiquettes, ni recherche, ni filtre, ni conversation, ni sélection. */
function expectNothingOfA(): void {
  const state = bibliography();
  expect(state.citations).toEqual([]);
  expect(state.filteredCitations).toEqual([]);
  expect(state.readingNotes).toEqual([]);
  expect(state.getAllTags()).toEqual([]);
  expect(state.searchQuery).toBe('');
  expect(state.selectedTags).toEqual([]);
  expect(state.selectedCitationId).toBeNull();
  expect(chat$.useChatStore.getState().messages).toEqual([]);
  expect(rag$.useRAGQueryStore.getState().params.selectedDocumentIds).toEqual([]);
  expect(rag$.useRAGQueryStore.getState().params.selectedCollectionKeys).toEqual([]);
}

describe('passer de A à B', () => {
  it('loadProject(A avec .bib) puis loadProject(B sans .bib) : rien de A ne reste', async () => {
    await openAWithEverything();
    projects.B = project('B');

    await open('B');

    expectNothingOfA();
    expect(lifecycle$.projectLifecycle.capture()?.path).toBe('/tmp/B');
  });

  it('createProject(B) après A : rien de A ne reste', async () => {
    await openAWithEverything();

    expect(await store().createProject('B', 'article', '/tmp')).toBe(true);

    expect(store().currentProject?.path).toBe('/tmp/B');
    expectNothingOfA();
  });

  it('closeProject : plus rien de A à l’écran', async () => {
    await openAWithEverything();

    await store().closeProject();

    expect(store().currentProject).toBeNull();
    expectNothingOfA();
    expect(lifecycle$.projectLifecycle.capture()).toBeNull();
  });

  it('project:closed (fermeture d’office) : les stores sont vidés', async () => {
    await openAWithEverything();
    expect(onClosed).not.toBeNull();

    onClosed!({ path: '/tmp/A', code: 'project_unavailable', error: 'timeout' });

    await vi.waitFor(() => expect(store().currentProject).toBeNull());
    expectNothingOfA();
    expect(lifecycle$.projectLifecycle.capture()).toBeNull();
  });

  it('B échoue et A ne revient pas (restoredPath null) : les stores de A sont vidés', async () => {
    await openAWithEverything();
    projects.B = project('B');
    loadResults['/tmp/B/project.json'] = { success: false, code: 'services_failed', error: 'panne', restoredPath: null };

    await expect(store().loadProject('/tmp/B/project.json')).rejects.toThrow();

    expect(store().currentProject).toBeNull();
    expectNothingOfA();
  });
});

describe('le même projet, ou le projet d’avant qui revient', () => {
  it('le même projet rouvert (style CSL, récents) : aucune remise à zéro', async () => {
    await openAWithEverything();
    const handleBefore = lifecycle$.projectLifecycle.capture();

    await open('A');

    expect(bibliography().searchQuery).toBe('préfet');
    expect(bibliography().selectedTags).toEqual(['à relire']);
    expect(chat$.useChatStore.getState().messages.map((m) => m.content)).toEqual(['Qui était le préfet en 1934 ?']);
    expect(rag$.useRAGQueryStore.getState().params.selectedDocumentIds).toEqual(['doc-a']);
    expect(lifecycle$.projectLifecycle.capture()?.path).toBe('/tmp/A');
    expect(handleBefore?.isCurrent()).toBe(false);
  });

  it('B échoue et A revient : ses stores sont intacts, et sa bibliographie est renvoyée au main', async () => {
    await openAWithEverything();
    projects.B = project('B');
    loadResults['/tmp/B/project.json'] = { success: false, code: 'services_failed', error: 'panne', restoredPath: '/tmp/A' };
    loadWithMetadata.mockClear();

    await expect(store().loadProject('/tmp/B/project.json')).rejects.toThrow();

    expect(store().currentProject?.path).toBe('/tmp/A');
    // Le main a fermé puis rouvert les services de A, bibliographie comprise : sans ce renvoi, ni
    // l'aperçu d'une citation ni les exports de A ne résolvaient plus rien.
    expect(loadWithMetadata).toHaveBeenCalledWith({ filePath: '/tmp/A/a.bib', projectPath: '/tmp/A' });
    expect(bibliography().citations.map((c) => c.id)).toEqual(['Dupont_1990']);
    expect(bibliography().searchQuery).toBe('préfet');
    expect(chat$.useChatStore.getState().messages.map((m) => m.content)).toEqual(['Qui était le préfet en 1934 ?']);
    expect(rag$.useRAGQueryStore.getState().params.selectedDocumentIds).toEqual(['doc-a']);
    expect(lifecycle$.projectLifecycle.capture()?.path).toBe('/tmp/A');
  });

  it('un refus de B avant toute bascule (fichier qui n’est pas un projet) : rien à renvoyer, rien de vidé', async () => {
    await openAWithEverything();
    loadWithMetadata.mockClear();
    const getMetadata = (window as unknown as { electron: { project: { getMetadata: ReturnType<typeof vi.fn> } } })
      .electron.project.getMetadata;
    getMetadata.mockResolvedValueOnce({ success: false, code: 'not_a_project', fileName: 'notes.json' });

    await expect(store().loadProject('/tmp/notes.json')).rejects.toThrow();

    expect(loadWithMetadata).not.toHaveBeenCalled();
    expect(bibliography().searchQuery).toBe('préfet');
    expect(lifecycle$.projectLifecycle.capture()?.path).toBe('/tmp/A');
  });
});
