/**
 * @vitest-environment jsdom
 *
 * Tests for the typed projectStore.loadState machine (fusion 3.10).
 *
 * The transitions matter for downstream UX: a toast that wants to
 * show the failure reason needs `failed.error`; a Brainstorm panel
 * that wants to defer rendering until ready can read `kind === 'ready'`
 * instead of guessing from `currentProject != null && !isLoading`.
 *
 * The IPC layer (`window.electron.project.*`) is replaced wholesale
 * with stubs so the store's behaviour is exercised in isolation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EditorFacade } from '@/editor/facade';
import { useProjectStore } from '../projectStore';
import { useEditorStore } from '../editorStore';
import { useDialogStore } from '../dialogStore';
import { useNotificationStore } from '../notificationStore';
import { useRebuildStore } from '../rebuildStore';
import i18n from '../../i18n';

interface ElectronStub {
  project: {
    load: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    getRecent: ReturnType<typeof vi.fn>;
    getMetadata: ReturnType<typeof vi.fn>;
    removeRecent: ReturnType<typeof vi.fn>;
    getChapters: ReturnType<typeof vi.fn>;
  };
  editor: { loadFile: ReturnType<typeof vi.fn> };
  fs: { writeFile: ReturnType<typeof vi.fn> };
}

let originalElectron: unknown;
let stub: ElectronStub;

const fakeProject = {
  id: 'p1',
  name: 'Demo',
  path: '/tmp/p1',
  type: 'article' as const,
  createdAt: new Date('2026-01-01').toISOString(),
  lastOpenedAt: new Date('2026-01-02').toISOString(),
};

beforeEach(() => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  stub = {
    project: {
      load: vi.fn(),
      create: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      getRecent: vi.fn().mockResolvedValue([]),
      getMetadata: vi.fn().mockResolvedValue({ success: true, project: fakeProject }),
      removeRecent: vi.fn().mockResolvedValue(undefined),
      getChapters: vi.fn().mockResolvedValue({ success: true, chapters: [] }),
    },
    editor: { loadFile: vi.fn().mockResolvedValue({ success: true, content: '# Demo\n' }) },
    fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
  };
  (window as unknown as { electron: ElectronStub }).electron = stub;
  useEditorStore.setState({
    filePath: null,
    content: '',
    isDirty: false,
    editorFacade: null,
    bufferDetached: false,
  });
  useNotificationStore.getState().dismissAll();
  // Reset store to a clean slate for every test.
  useProjectStore.setState({
    currentProject: null,
    chapters: [],
    currentChapterId: null,
    loadState: { kind: 'idle' },
    recentProjects: [],
  });
});

afterEach(() => {
  (window as unknown as { electron?: unknown }).electron = originalElectron;
});

describe('projectStore.loadState — initial state', () => {
  it('starts in `idle`', () => {
    expect(useProjectStore.getState().loadState).toEqual({ kind: 'idle' });
  });
});

describe('projectStore.loadProject — happy path', () => {
  it('transitions idle → loading → ready and exposes the loaded path', async () => {
    stub.project.load.mockResolvedValue({
      success: true,
      project: fakeProject,
    });

    const transitions: string[] = [];
    const unsubscribe = useProjectStore.subscribe((s) =>
      transitions.push(s.loadState.kind)
    );

    await useProjectStore.getState().loadProject('/tmp/p1');
    unsubscribe();

    expect(transitions).toContain('loading');
    expect(transitions[transitions.length - 1]).toBe('ready');
    const finalState = useProjectStore.getState().loadState;
    expect(finalState.kind).toBe('ready');
    if (finalState.kind === 'ready') {
      expect(finalState.path).toBe('/tmp/p1');
      expect(typeof finalState.loadedAt).toBe('string');
    }
    expect(useProjectStore.getState().currentProject?.id).toBe('p1');
    // Le document existe : il s'ouvre, et le repli n'a rien à écrire.
    expect(useEditorStore.getState().filePath).toBe('/tmp/p1/document.md');
    expect(useEditorStore.getState().content).toBe('# Demo\n');
    expect(stub.fs.writeFile).not.toHaveBeenCalled();
  });
});

/**
 * Toute erreur de lecture passait pour un fichier absent : le repli écrivait « # Nom » à
 * la place d'un document présent. Le piège signalé dès la PR #42.
 */
describe('projectStore.loadProject — le document ne s’ouvre pas', () => {
  const DOCUMENT = '/tmp/p1/document.md';
  const absent = { success: false, code: 'absent', error: 'ENOENT' };
  const toasts = () => useNotificationStore.getState().notifications;

  const expectUntitledBuffer = () => {
    expect(useEditorStore.getState().filePath).toBeNull();
    expect(useEditorStore.getState().bufferDetached).toBe(false);
    expect(useProjectStore.getState().loadState.kind).toBe('ready');
    expect(useProjectStore.getState().currentChapterId).toBeNull();
  };

  beforeEach(() => {
    stub.project.load.mockResolvedValue({ success: true, project: fakeProject });
  });

  it.each([
    ['droits retirés', { success: false, code: 'unreadable', reason: 'permission', error: 'EACCES' }],
    ['un dossier à la place', { success: false, code: 'unreadable', reason: 'not-a-file', error: 'EISDIR' }],
    ['erreur du disque', { success: false, code: 'unreadable', reason: 'io', error: 'EIO' }],
    ['réponse sans code', { success: false, error: 'tout autre échec' }],
  ])('illisible (%s) : rien n’est écrit, l’auteur est prévenu, tampon sans titre', async (_label, response) => {
    stub.editor.loadFile.mockResolvedValue(response);

    await useProjectStore.getState().loadProject('/tmp/p1');

    expect(stub.fs.writeFile).not.toHaveBeenCalled();
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({
      level: 'error',
      title: i18n.t('project.documentOpenError'),
      message: `${i18n.t('project.documentOpenUnchanged')} ${i18n.t('project.documentOpenUntitled')}`,
    });
    expect(toasts()[0].details).toContain(DOCUMENT);
    expectUntitledBuffer();
  });

  it('pas en UTF-8 : rien n’est écrit, et le message dit quoi faire', async () => {
    stub.editor.loadFile.mockResolvedValue({
      success: false,
      code: 'unreadable',
      reason: 'encoding',
      error: 'pas UTF-8',
    });

    await useProjectStore.getState().loadProject('/tmp/p1');

    expect(stub.fs.writeFile).not.toHaveBeenCalled();
    expect(toasts()).toHaveLength(1);
    // Quoi faire du fichier, et ce que devient ce qu'on tape : l'un ne remplace pas l'autre.
    expect(toasts()[0].message).toBe(`${i18n.t('editor.notUtf8')} ${i18n.t('project.documentOpenUntitled')}`);
    expectUntitledBuffer();
  });

  it('le pont lui-même échoue : ce n’est pas un fichier absent', async () => {
    stub.editor.loadFile.mockRejectedValue(new Error('canal coupé'));

    await useProjectStore.getState().loadProject('/tmp/p1');

    expect(stub.fs.writeFile).not.toHaveBeenCalled();
    expect(toasts()).toHaveLength(1);
    expectUntitledBuffer();
  });

  it('absent : créé sans pouvoir écraser, puis ouvert', async () => {
    stub.editor.loadFile
      .mockResolvedValueOnce(absent)
      .mockResolvedValueOnce({ success: true, content: '# Demo\n' });

    await useProjectStore.getState().loadProject('/tmp/p1');

    expect(stub.fs.writeFile).toHaveBeenCalledTimes(1);
    expect(stub.fs.writeFile).toHaveBeenCalledWith(DOCUMENT, '# Demo\n', { exclusive: true });
    expect(useEditorStore.getState().filePath).toBe(DOCUMENT);
    expect(useEditorStore.getState().content).toBe('# Demo\n');
    expect(toasts()).toEqual([]);
  });

  it('présentation absente : c’est slides.md qui se crée', async () => {
    stub.project.load.mockResolvedValue({
      success: true,
      project: { ...fakeProject, type: 'presentation' },
    });
    stub.editor.loadFile
      .mockResolvedValueOnce(absent)
      .mockResolvedValueOnce({ success: true, content: '# Demo\n' });

    await useProjectStore.getState().loadProject('/tmp/p1');

    expect(stub.fs.writeFile).toHaveBeenCalledWith('/tmp/p1/slides.md', '# Demo\n', { exclusive: true });
  });

  it('livre au chapitre absent : rien n’est créé, un manuscrit ne s’invente pas', async () => {
    stub.project.load.mockResolvedValue({
      success: true,
      project: { ...fakeProject, type: 'book' },
    });
    stub.project.getChapters.mockResolvedValue({
      success: true,
      chapters: [{ id: 'c1', title: 'Un', filePath: 'chapters/01.md', order: 0, kind: 'chapter' }],
    });
    stub.editor.loadFile.mockResolvedValue(absent);

    await useProjectStore.getState().loadProject('/tmp/p1');

    expect(stub.fs.writeFile).not.toHaveBeenCalled();
    expect(toasts()).toHaveLength(1);
    expectUntitledBuffer();
  });

  it('absent, et la création échoue : prévenu, tampon sans titre', async () => {
    stub.editor.loadFile.mockResolvedValue(absent);
    stub.fs.writeFile.mockRejectedValue(new Error('EEXIST: file already exists'));

    await useProjectStore.getState().loadProject('/tmp/p1');

    expect(stub.fs.writeFile).toHaveBeenCalledTimes(1);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].details).toContain('EEXIST');
    expectUntitledBuffer();
  });

  it('rouvrir le projet : un seul message, et plus aucun une fois le fichier réparé', async () => {
    const unreadable = { success: false, code: 'unreadable', reason: 'encoding', error: 'pas UTF-8' };
    stub.editor.loadFile.mockResolvedValue(unreadable);

    await useProjectStore.getState().loadProject('/tmp/p1');
    await useProjectStore.getState().loadProject('/tmp/p1');
    expect(toasts()).toHaveLength(1);

    stub.editor.loadFile.mockResolvedValue({ success: true, content: '# Demo\n' });
    await useProjectStore.getState().loadProject('/tmp/p1');

    expect(toasts()).toEqual([]);
    expect(useEditorStore.getState().filePath).toBe(DOCUMENT);
  });

  it('fermer le projet : le message ne lui survit pas', async () => {
    stub.editor.loadFile.mockResolvedValue({ success: false, code: 'unreadable', error: 'EACCES' });
    await useProjectStore.getState().loadProject('/tmp/p1');
    expect(toasts()).toHaveLength(1);

    await useProjectStore.getState().closeProject();

    expect(toasts()).toEqual([]);
  });

  it('createProject suit la même règle', async () => {
    stub.project.create.mockResolvedValue({ success: true, project: fakeProject });
    stub.editor.loadFile.mockResolvedValue({
      success: false,
      code: 'unreadable',
      reason: 'permission',
      error: 'EACCES',
    });

    await useProjectStore.getState().createProject('Demo', 'article', '/tmp');

    expect(stub.fs.writeFile).not.toHaveBeenCalled();
    expect(toasts()).toHaveLength(1);
    expect(useEditorStore.getState().filePath).toBeNull();
  });
});

describe('projectStore.loadProject — failure path', () => {
  it('captures the error message in `failed` and re-throws', async () => {
    stub.project.load.mockResolvedValue({
      success: false,
      error: 'Workspace v3 not supported',
    });

    await expect(
      useProjectStore.getState().loadProject('/tmp/bad')
    ).rejects.toThrow(/Workspace v3 not supported/);

    const finalState = useProjectStore.getState().loadState;
    expect(finalState.kind).toBe('failed');
    if (finalState.kind === 'failed') {
      expect(finalState.path).toBe('/tmp/bad');
      expect(finalState.error).toMatch(/Workspace v3 not supported/);
      expect(typeof finalState.at).toBe('string');
    }
  });

  it('captures a thrown Error instance verbatim', async () => {
    stub.project.load.mockRejectedValue(new Error('Network down'));
    await expect(
      useProjectStore.getState().loadProject('/tmp/x')
    ).rejects.toThrow(/Network down/);
    const s = useProjectStore.getState().loadState;
    expect(s.kind).toBe('failed');
    if (s.kind === 'failed') expect(s.error).toBe('Network down');
  });

  it('allows a retry from failed (failed → loading → ready)', async () => {
    stub.project.load
      .mockResolvedValueOnce({ success: false, error: 'transient' })
      .mockResolvedValueOnce({ success: true, project: fakeProject });

    await expect(
      useProjectStore.getState().loadProject('/tmp/p1')
    ).rejects.toThrow();
    expect(useProjectStore.getState().loadState.kind).toBe('failed');

    await useProjectStore.getState().loadProject('/tmp/p1');
    expect(useProjectStore.getState().loadState.kind).toBe('ready');
  });
});

describe('projectStore.closeProject — resets to idle', () => {
  it('transitions ready → idle and clears the project', async () => {
    stub.project.load.mockResolvedValue({
      success: true,
      project: fakeProject,
    });
    await useProjectStore.getState().loadProject('/tmp/p1');
    expect(useProjectStore.getState().loadState.kind).toBe('ready');

    await useProjectStore.getState().closeProject();
    expect(useProjectStore.getState().loadState).toEqual({ kind: 'idle' });
    expect(useProjectStore.getState().currentProject).toBeNull();
  });

  it('still resets to idle even when the IPC close fails', async () => {
    stub.project.load.mockResolvedValue({
      success: true,
      project: fakeProject,
    });
    await useProjectStore.getState().loadProject('/tmp/p1');

    stub.project.close.mockRejectedValueOnce(new Error('handle leak'));
    await useProjectStore.getState().closeProject();
    expect(useProjectStore.getState().loadState).toEqual({ kind: 'idle' });
  });

  describe('le message d’échec d’une reconstruction', () => {
    const failed = {
      current: 90,
      total: 100,
      status: 'Error: disque plein',
      percentage: 90,
      phase: 'failed' as const,
      error: 'disque plein',
    };

    afterEach(() => useRebuildStore.getState().resetProgress());

    it('part avec le projet fermé', async () => {
      stub.project.load.mockResolvedValue({ success: true, project: fakeProject });
      await useProjectStore.getState().loadProject('/tmp/p1');
      useRebuildStore.getState().setRebuildProgress(failed);

      await useProjectStore.getState().closeProject();

      expect(useRebuildStore.getState().failure).toBeNull();
    });

    it('publié pendant la fermeture du main, il part aussi : la base se ferme sous la reconstruction', async () => {
      stub.project.load.mockResolvedValue({ success: true, project: fakeProject });
      await useProjectStore.getState().loadProject('/tmp/p1');
      stub.project.close.mockImplementation(async () => {
        useRebuildStore.getState().setRebuildProgress(failed);
      });

      await useProjectStore.getState().closeProject();

      expect(useRebuildStore.getState().failure).toBeNull();
    });
  });
});

describe('projectStore.createProject — same machine', () => {
  it('transitions idle → loading → ready on success', async () => {
    stub.project.create.mockResolvedValue({
      success: true,
      project: fakeProject,
    });
    await useProjectStore.getState().createProject('Demo', 'article', '/tmp/p1');
    const s = useProjectStore.getState().loadState;
    expect(s.kind).toBe('ready');
    if (s.kind === 'ready') expect(s.path).toBe('/tmp/p1');
  });

  it('transitions idle → loading → failed on error', async () => {
    stub.project.create.mockRejectedValue(new Error('disk full'));
    await expect(
      useProjectStore.getState().createProject('Demo', 'article', '/tmp/p1')
    ).rejects.toThrow(/disk full/);
    const s = useProjectStore.getState().loadState;
    expect(s.kind).toBe('failed');
    if (s.kind === 'failed') expect(s.error).toBe('disk full');
  });
});

describe('projectStore — bascule refusée pendant une renumérotation', () => {
  const inProgress = i18n.t('book.renumberInProgress');
  const opened = { ...fakeProject, createdAt: new Date(), lastOpenedAt: new Date() };
  const openedState = { kind: 'ready', loadedAt: 'avant', path: '/tmp/p1' } as const;

  beforeEach(() => {
    useProjectStore.setState({ currentProject: opened, loadState: openedState });
    useEditorStore.setState({ switchLock: 'book.renumberInProgress' } as never);
  });

  afterEach(() => {
    useEditorStore.setState({ switchLock: null } as never);
    useProjectStore.setState({ currentProject: null });
    while (useDialogStore.getState().alertOpen) useDialogStore.getState().closeAlert();
  });

  it('loadProject n’appelle pas le main, garde le projet et dit pourquoi', async () => {
    const refused = useProjectStore.getState().loadProject('/tmp/p2');
    await vi.waitFor(() => expect(useDialogStore.getState().alertOpen).toBe(true));
    expect(useProjectStore.getState().loadState).toBe(openedState);
    useDialogStore.getState().closeAlert();
    await refused;

    expect(stub.project.load).not.toHaveBeenCalled();
    expect(useProjectStore.getState().currentProject).toBe(opened);
    expect(useProjectStore.getState().loadState).toBe(openedState);
  });

  it('closeProject n’appelle pas le main, garde le projet et dit pourquoi', async () => {
    const refused = Promise.resolve(useProjectStore.getState().closeProject());
    await vi.waitFor(() => expect(useDialogStore.getState().alertMessage).toBe(inProgress));
    useDialogStore.getState().closeAlert();
    await refused;

    expect(stub.project.close).not.toHaveBeenCalled();
    expect(useProjectStore.getState().currentProject).toBe(opened);
  });

  it('closeProject refusé : le message d’échec du projet resté ouvert reste aussi', async () => {
    useRebuildStore.getState().setRebuildProgress({
      current: 90,
      total: 100,
      status: 'Error: disque plein',
      percentage: 90,
      phase: 'failed',
      error: 'disque plein',
    });

    const refused = Promise.resolve(useProjectStore.getState().closeProject());
    await vi.waitFor(() => expect(useDialogStore.getState().alertMessage).toBe(inProgress));
    useDialogStore.getState().closeAlert();
    await refused;

    expect(useRebuildStore.getState().failure).toBe('disque plein');
    useRebuildStore.getState().resetProgress();
  });

  it('createProject n’appelle pas le main, garde le projet et dit pourquoi', async () => {
    const refused = useProjectStore.getState().createProject('Neuf', 'article', '/tmp');
    await vi.waitFor(() => expect(useDialogStore.getState().alertMessage).toBe(inProgress));
    // Aucun voile de chargement derrière l'alerte : le refus arrive avant tout.
    expect(useProjectStore.getState().loadState).toBe(openedState);
    useDialogStore.getState().closeAlert();

    expect(await refused).toBe(false);
    expect(stub.project.create).not.toHaveBeenCalled();
    expect(useProjectStore.getState().currentProject).toBe(opened);
    expect(useProjectStore.getState().loadState).toBe(openedState);
  });

  it('une fois le verrou levé, les deux repartent', async () => {
    useEditorStore.setState({ switchLock: null } as never);

    await useProjectStore.getState().closeProject();

    expect(stub.project.close).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().currentProject).toBeNull();
    expect(useDialogStore.getState().alertOpen).toBe(false);
  });
});

/**
 * Le main n'autorise que les fichiers du projet courant : une fois `project.load`
 * passé, le sortant ne peut plus être écrit. Ce refus faisait rejeter la porte, et le
 * repli de `loadProject` réécrivait alors le document du projet entrant.
 */
describe('projectStore — le document sortant, avant de quitter son projet', () => {
  const A = '/tmp/p1/document.md';
  const B = '/tmp/p2/document.md';
  const projectB = { ...fakeProject, id: 'p2', name: 'B', path: '/tmp/p2' };
  const B_TEXT = '# Huit mille mots de B\n';

  let disk: Record<string, string>;
  let writes: Array<[string, string]>;
  let allowedRoot: string;
  let live: string;
  /** Une écriture lente laisse à l'auteur le temps de taper. */
  let duringWrite: () => void;
  let writesAtSwitch: number;

  /** La frappe que ni `isDirty` ni le miroir ne voient : écriture lente, synchro debouncée. */
  function openWithUnsyncedText(text: string): void {
    live = text;
    useEditorStore.setState({
      filePath: A,
      content: '# A\n',
      isDirty: false,
      editorFacade: { getValue: () => live } as unknown as EditorFacade,
    });
  }

  function passMainToB(): void {
    writesAtSwitch = writes.length;
    allowedRoot = '/tmp/p2';
  }

  beforeEach(() => {
    disk = { [A]: '# A\n', [B]: B_TEXT };
    writes = [];
    allowedRoot = '/tmp/p1';
    duringWrite = () => undefined;
    writesAtSwitch = -1;
    stub.fs.writeFile.mockImplementation(async (path: string, content: string) => {
      disk[path] = content;
    });
    stub.project.load.mockImplementation(async () => {
      passMainToB();
      return { success: true, project: projectB };
    });
    stub.project.create.mockImplementation(async () => {
      passMainToB();
      return { success: true, project: projectB };
    });
    stub.project.close.mockImplementation(async () => {
      passMainToB();
    });
    (window as unknown as { electron: unknown }).electron = {
      ...stub,
      editor: {
        loadFile: async (path: string) =>
          path in disk ? { success: true, content: disk[path] } : { success: false, error: 'ENOENT' },
        saveFile: async (path: string, content: string) => {
          if (!path.startsWith(`${allowedRoot}/`)) return { success: false, error: 'Write access denied' };
          duringWrite();
          writes.push([path, content]);
          disk[path] = content;
          return { success: true };
        },
      },
    };
  });

  afterEach(() => {
    useEditorStore.setState({ filePath: null, content: '', isDirty: false, editorFacade: null });
  });

  it('loadProject : la frappe va dans son fichier avant le passage du main, et B reste intact', async () => {
    openWithUnsyncedText('# A\nphrase\n');

    await useProjectStore.getState().loadProject('/tmp/p2');

    expect(disk[A]).toBe('# A\nphrase\n');
    expect(writesAtSwitch).toBe(1);
    expect(stub.fs.writeFile).not.toHaveBeenCalled();
    expect(disk[B]).toBe(B_TEXT);
    expect(useEditorStore.getState().filePath).toBe(B);
    expect(useEditorStore.getState().content).toBe(B_TEXT);
  });

  it('loadProject : frappe pendant cette écriture, écrite elle aussi avant le passage du main', async () => {
    openWithUnsyncedText('# A\nun\n');
    let passes = 0;
    duringWrite = () => {
      passes += 1;
      if (passes === 1) live = '# A\nun\ndeux\n';
    };

    await useProjectStore.getState().loadProject('/tmp/p2');

    expect(writes.map(([, content]) => content)).toEqual(['# A\nun\n', '# A\nun\ndeux\n']);
    expect(writesAtSwitch).toBe(2);
    expect(stub.fs.writeFile).not.toHaveBeenCalled();
    expect(disk[B]).toBe(B_TEXT);
  });

  it('createProject : la frappe va dans son fichier avant le passage du main', async () => {
    openWithUnsyncedText('# A\nphrase\n');

    await useProjectStore.getState().createProject('B', 'article', '/tmp/p2');

    expect(disk[A]).toBe('# A\nphrase\n');
    expect(writesAtSwitch).toBe(1);
  });

  it('closeProject : la frappe va dans son fichier avant la fermeture', async () => {
    openWithUnsyncedText('# A\nphrase\n');

    await useProjectStore.getState().closeProject();

    expect(disk[A]).toBe('# A\nphrase\n');
    expect(writesAtSwitch).toBe(1);
  });

  it('rien de neuf : le fichier sortant n’est pas réécrit', async () => {
    openWithUnsyncedText('# A\n');

    await useProjectStore.getState().loadProject('/tmp/p2');

    expect(writes).toEqual([]);
    expect(useEditorStore.getState().filePath).toBe(B);
  });
});
