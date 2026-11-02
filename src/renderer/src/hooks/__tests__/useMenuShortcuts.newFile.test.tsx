// @vitest-environment jsdom
/**
 * Fichier › Nouveau fichier (Cmd+N) et les autres entrées de fichier du menu.
 *
 * Le menu appelait `createNewFile` sans question et sans écrire le fichier ouvert,
 * alors que le bouton de la barre d'outils suivait un autre chemin. Dans un livre, il
 * sortait l'auteur du manuscrit, ce que le bouton évitait déjà.
 *
 * Vrais hook et stores ; le disque est simulé derrière l'IPC, et le menu natif réduit à
 * ses gestionnaires capturés.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import type { EditorFacade } from '@/editor/facade';
import { useMenuShortcuts } from '../useMenuShortcuts';
import { useEditorStore } from '../../stores/editorStore';
import { useProjectStore } from '../../stores/projectStore';
import { useDialogStore } from '../../stores/dialogStore';

const PROJECT = '/p/projet';
const DOCUMENT = `${PROJECT}/document.md`;

let handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
let disk: Record<string, string>;
let createChapter: ReturnType<typeof vi.fn>;
let openFile: ReturnType<typeof vi.fn>;
let saveDialog: ReturnType<typeof vi.fn>;
let live: string;

/** La vue, réduite au texte vivant. */
const facade = () =>
  ({ getValue: () => live, setValue: () => undefined }) as unknown as EditorFacade;

function mount(type: 'article' | 'book'): void {
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Projet',
      path: PROJECT,
      type,
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
  });
  live = disk[DOCUMENT];
  useEditorStore.setState({
    filePath: DOCUMENT,
    content: disk[DOCUMENT],
    isDirty: false,
    switchLock: null,
    editorFacade: facade(),
  });
  renderHook(() => useMenuShortcuts());
}

/** Déclenche une entrée de menu telle que le preload la relaie. */
async function menu(channel: string): Promise<void> {
  await act(async () => {
    for (const handler of handlers.get(channel) ?? []) void handler({});
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function answerConfirm(value: boolean): Promise<void> {
  await act(async () => {
    useDialogStore.getState().resolveConfirm(value);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const dialogs = () => useDialogStore.getState();

beforeEach(() => {
  handlers = new Map();
  disk = { [DOCUMENT]: '# Article\n' };
  createChapter = vi.fn(async () => ({ success: true }));
  openFile = vi.fn(async () => ({ canceled: false, filePaths: [`${PROJECT}/context.md`] }));
  saveDialog = vi.fn(async () => ({ canceled: false, filePath: '/ailleurs/note.md' }));
  (window as unknown as { electron: unknown }).electron = {
    project: {
      createChapter,
      getChapters: vi.fn(async () => ({ success: true, chapters: [], unattached: [] })),
    },
    editor: {
      loadFile: vi.fn(async (path: string) => ({ success: true, content: disk[path] ?? '' })),
      saveFile: vi.fn(async (path: string, content: string) => {
        disk[path] = content;
        return { success: true };
      }),
    },
    dialog: { openFile, saveFile: saveDialog },
    ipcRenderer: {
      on: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
      },
      removeListener: () => undefined,
    },
  };
});

afterEach(() => {
  cleanup();
  useEditorStore.setState({ editorFacade: null, switchLock: null } as never);
  useProjectStore.setState({ currentProject: null, chapters: [] });
  while (dialogs().confirmOpen) dialogs().resolveConfirm(false);
  while (dialogs().alertOpen) dialogs().closeAlert();
});

describe('menu:new-file', () => {
  it('livre : ajoute un chapitre, et l’auteur ne sort pas du manuscrit', async () => {
    mount('book');

    await menu('menu:new-file');

    expect(createChapter).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().filePath).toBe(DOCUMENT);
    expect(dialogs().confirmOpen).toBe(false);
  });

  it('article : la même question que le bouton, et le fichier ouvert écrit d’abord', async () => {
    mount('article');
    live = '# Article\nfrappe\n';

    await menu('menu:new-file');
    expect(dialogs().confirmMessage).toBe('toolbar.newFileConfirm');
    expect(useEditorStore.getState().filePath).toBe(DOCUMENT);
    await answerConfirm(true);

    expect(disk[DOCUMENT]).toBe('# Article\nfrappe\n');
    expect(useEditorStore.getState().filePath).toBeNull();
  });

  it('article : Annuler laisse le document', async () => {
    mount('article');

    await menu('menu:new-file');
    await answerConfirm(false);

    expect(useEditorStore.getState().filePath).toBe(DOCUMENT);
  });

  // Ce que font aujourd'hui les écouteurs jamais retirés : la commande part deux fois.
  const doubleListener = () => {
    const [handler] = handlers.get('menu:new-file') ?? [];
    handlers.set('menu:new-file', [handler, handler]);
  };

  it('écouteur doublé, article : une seule question', async () => {
    mount('article');
    doubleListener();

    await menu('menu:new-file');

    expect(dialogs().queue).toHaveLength(1);
  });

  it('écouteur doublé, livre : un seul chapitre', async () => {
    mount('book');
    doubleListener();

    await menu('menu:new-file');

    expect(createChapter).toHaveBeenCalledTimes(1);
  });
});

describe('menu:save-file sur un tampon sans titre', () => {
  // Le nom proposé arrivait dans le dernier dossier, souvent celui du projet : valider
  // ce nom remplaçait le manuscrit, et seule l'invite du système l'empêchait.
  it('ne propose aucun nom : document.md ne se remplace plus d’un simple Entrée', async () => {
    mount('article');
    await menu('menu:new-file');
    await answerConfirm(true);
    // La vue du tampon se monte ; l'auteur y tape.
    live = 'Une idée à part.';
    useEditorStore.setState({ editorFacade: facade() });

    await menu('menu:save-file');

    expect(saveDialog).toHaveBeenCalled();
    expect(saveDialog.mock.calls[0][0]).not.toHaveProperty('defaultPath');
    expect(disk[DOCUMENT]).toBe('# Article\n');
    expect(disk['/ailleurs/note.md']).toBe('Une idée à part.');
  });

  it('passe l’option d’invite de remplacement, documentée pour Linux', async () => {
    mount('article');
    useEditorStore.setState({ filePath: null, content: '', isDirty: true });
    live = 'Une page.';

    await menu('menu:save-file');

    expect(saveDialog.mock.calls[0][0].properties).toContain('showOverwriteConfirmation');
  });
});

describe('les entrées de fichier du menu sous le verrou', () => {
  it('menu:open-file dit la raison du refus, où il ne disait rien', async () => {
    mount('article');
    useEditorStore.getState().setSwitchLock('book.renumberInProgress');

    await menu('menu:open-file');

    expect(openFile).toHaveBeenCalled();
    expect(dialogs().alertMessage).toBe('book.renumberInProgress');
    expect(useEditorStore.getState().filePath).toBe(DOCUMENT);
  });

  it('menu:save-file sur un tampon sans titre dit la raison du refus', async () => {
    mount('article');
    useEditorStore.setState({ filePath: null, content: '', isDirty: true });
    live = 'Une page.';
    useEditorStore.getState().setSwitchLock('book.renumberInProgress');

    await menu('menu:save-file');

    expect(saveDialog).toHaveBeenCalled();
    expect(dialogs().alertMessage).toBe('book.renumberInProgress');
    expect(disk['/ailleurs/note.md']).toBeUndefined();
    expect(useEditorStore.getState().filePath).toBeNull();
  });
});
