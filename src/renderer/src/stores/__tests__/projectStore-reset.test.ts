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
type IdeaStoreModule = typeof import('../ideaStore');

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
/** Les `ideas.json` sur le disque, et les écritures demandées au main. */
let ideasFiles: Record<string, string>;
let writeFile: ReturnType<typeof vi.fn>;

let projects$: ProjectStoreModule;
let bibliography$: BibliographyStoreModule;
let chat$: ChatStoreModule;
let rag$: RagStoreModule;
let lifecycle$: LifecycleModule;
let ideas$: IdeaStoreModule;

const byPath = (p: string) => projects[p.replace(/^\/tmp\//, '').replace(/\/project\.json$/, '')];

beforeEach(async () => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  projects = {};
  loadResults = {};
  onClosed = null;
  loadWithMetadata = vi.fn(async () => ({ success: true, citations: [CITATION_A], unreadKeys: [], metadataUnreadable: false }));
  listNotes = vi.fn(async () => ({ success: true, notes: [NOTE_A] }));
  ideasFiles = {};
  writeFile = vi.fn(async () => undefined);
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
    fs: {
      writeFile,
      exists: vi.fn(async () => true),
      readUserFile: vi.fn(async (p: string) =>
        p in ideasFiles ? { kind: 'ok', content: ideasFiles[p] } : { kind: 'absent' }
      ),
    },
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
  ideas$ = await import('../ideaStore');
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

  /**
   * Un `.bib` reçu pendant la session (import, synchronisation Zotero) : le main l'écrit dans
   * `project.json`, le panneau le relit, mais `currentProject` reste la copie prise à l'ouverture.
   * Le parcours d'un nouvel utilisateur : créer le projet, puis importer sa bibliographie.
   */
  async function openAThenImportBibliography(): Promise<void> {
    projects.A = project('A');
    await open('A');
    projects.A = project('A', 'zotero-export.bib');
    await bibliography().loadBibliographyWithMetadata('/tmp/A/zotero-export.bib', '/tmp/A');
    expect(bibliography().citations.map((c) => c.id)).toEqual(['Dupont_1990']);
    expect(store().currentProject?.bibliographySource).toBeUndefined();
    loadWithMetadata.mockClear();
  }

  const electronProject = () =>
    (window as unknown as { electron: { project: Record<string, ReturnType<typeof vi.fn>> } }).electron.project;

  it('.bib importé après l’ouverture, B échoue et A revient : la bibliographie renvoyée est celle du manifeste d’aujourd’hui', async () => {
    await openAThenImportBibliography();
    projects.B = project('B');
    loadResults['/tmp/B/project.json'] = { success: false, code: 'services_failed', error: 'panne', restoredPath: '/tmp/A' };

    await expect(store().loadProject('/tmp/B/project.json')).rejects.toThrow();

    expect(store().currentProject?.path).toBe('/tmp/A');
    expect(loadWithMetadata).toHaveBeenCalledWith({ filePath: '/tmp/A/zotero-export.bib', projectPath: '/tmp/A' });
    expect(bibliography().citations.map((c) => c.id)).toEqual(['Dupont_1990']);
  });

  it('.bib importé après l’ouverture, création refusée avant toute bascule (nom déjà pris) : rien à relire, rien de vidé', async () => {
    await openAThenImportBibliography();
    // Le main refuse avant la séquence d'ouverture : aucun `restoredPath`, rien n'a été fermé.
    electronProject().create.mockResolvedValueOnce({ success: false, error: 'project_exists' });

    await expect(store().createProject('A', 'article', '/tmp')).rejects.toThrow();

    expect(store().currentProject?.path).toBe('/tmp/A');
    expect(loadWithMetadata).not.toHaveBeenCalled();
    expect(bibliography().citations.map((c) => c.id)).toEqual(['Dupont_1990']);
    expect(lifecycle$.projectLifecycle.capture()?.path).toBe('/tmp/A');
  });

  it('.bib importé après l’ouverture, projet créé mais en panne, A revient : sa bibliographie est renvoyée au main', async () => {
    await openAThenImportBibliography();
    electronProject().create.mockResolvedValueOnce({
      success: false,
      code: 'services_failed',
      error: 'panne',
      restoredPath: '/tmp/A',
    });

    await expect(store().createProject('C', 'article', '/tmp')).rejects.toThrow();

    expect(store().currentProject?.path).toBe('/tmp/A');
    expect(loadWithMetadata).toHaveBeenCalledWith({ filePath: '/tmp/A/zotero-export.bib', projectPath: '/tmp/A' });
    expect(bibliography().citations.map((c) => c.id)).toEqual(['Dupont_1990']);
  });

  it('A revient mais son manifeste ne se relit pas : la liste à l’écran n’est pas vidée', async () => {
    await openAThenImportBibliography();
    projects.B = project('B');
    loadResults['/tmp/B/project.json'] = { success: false, code: 'services_failed', error: 'panne', restoredPath: '/tmp/A' };
    electronProject().getMetadata.mockImplementation(async (p: string) =>
      p === '/tmp/A/project.json' ? { success: false, code: 'manifest_unreadable', error: 'EIO' } : { success: true, project: byPath(p) }
    );

    await expect(store().loadProject('/tmp/B/project.json')).rejects.toThrow();

    expect(store().currentProject?.path).toBe('/tmp/A');
    expect(loadWithMetadata).not.toHaveBeenCalled();
    expect(bibliography().citations.map((c) => c.id)).toEqual(['Dupont_1990']);
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

describe('les idées du Brainstorm (L03-5)', () => {
  const ideas = () => ideas$.useIdeaStore.getState();
  const ideasWrites = () => writeFile.mock.calls.filter(([filePath]) => String(filePath).endsWith('ideas.json'));

  beforeEach(async () => {
    ideasFiles['/tmp/A/.cliodeck/ideas.json'] = JSON.stringify({
      ideas: [{ id: 'i1', title: 'Idée de A', content: '', tags: [], links: [], origin: { type: 'manual' } }],
    });
    projects.A = project('A');
    projects.B = project('B');
    await open('A');
    await ideas().loadIdeas('/tmp/A');
    expect(ideas().loadedFor).toBe('/tmp/A');
  });

  it('project:closed (fermeture d’office) : la liste de A part, sans rien écrire nulle part', async () => {
    onClosed!({ path: '/tmp/A', code: 'project_unavailable', error: 'timeout' });
    await vi.waitFor(() => expect(store().currentProject).toBeNull());

    expect(ideas().ideas).toEqual([]);
    expect(ideas().loadedFor).toBeNull();
    await ideas().flushIdeas();
    await open('B');
    expect(ideasWrites()).toEqual([]);
  });

  it('project:closed avec une idée non écrite : rien ne s’écrit, ni dans A ni dans B, et B ne la reçoit pas', async () => {
    ideas().updateIdea('i1', { content: 'Tapé, jamais quitté le champ.' });

    onClosed!({ path: '/tmp/A', code: 'project_unavailable', error: 'timeout' });
    await vi.waitFor(() => expect(store().currentProject).toBeNull());
    await open('B');

    expect(ideas().ideas).toEqual([]);
    expect(ideas().loadedFor).toBeNull();
    await ideas().flushIdeas();
    expect(ideasWrites()).toEqual([]);
  });
});
