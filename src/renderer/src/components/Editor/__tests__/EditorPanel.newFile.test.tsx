// @vitest-environment jsdom
/**
 * « Nouveau fichier » (barre d'outils), et les refus du verrou dans ce panneau.
 *
 * Le bouton vidait l'éditeur sans changer de fichier : 3 s plus tard, l'autosave
 * écrivait un document.md de 0 octet, et la frappe suivante le remplaçait, alors que
 * la question ne parlait que des « modifications non sauvegardées ».
 *
 * Vrais EditorPanel, useAutoSave et stores ; le disque est simulé derrière l'IPC et la
 * vue CM6 réduite à ce qu'elle fait pour le store : façade, `isDirty` posé à chaque
 * modification. La vraie vue a ses tests à part (`CodeMirrorEditor.buffer.test.tsx`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';

import { EditorPanel } from '../EditorPanel';
import { useAutoSave } from '../../../hooks/useAutoSave';
import i18n from '../../../i18n';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useDialogStore } from '../../../stores/dialogStore';

vi.mock('../CodeMirrorEditor', async () => {
  const React = await import('react');
  const { useEditorStore: store } = await import('../../../stores/editorStore');
  const CodeMirrorEditor = () => {
    const documentVersion = store((s) => s.documentVersion);
    React.useEffect(() => {
      let text = store.getState().content;
      let destroyed = false;
      store.getState().setEditorFacade({
        getValue: () => text,
        setValue: (next: string) => {
          if (destroyed) return;
          text = next;
          store.setState({ isDirty: true });
        },
        onContentChange: () => () => undefined,
        onSelectionChange: () => () => undefined,
        getCursorOffset: () => 0,
      } as never);
      return () => {
        destroyed = true;
        store.getState().setEditorFacade(null);
      };
    }, [documentVersion]);
    return null;
  };
  return { CodeMirrorEditor };
});

/** Comme App : l'autosave à côté du panneau, pas dedans. */
const AutoSave = (): null => {
  useAutoSave();
  return null;
};

const PROJECT = '/p/projet';
const DOCUMENT = `${PROJECT}/document.md`;
const SLIDES = `${PROJECT}/slides.md`;
const ARTICLE = '# Article\n\nHuit mille mots déjà enregistrés.\n';
const NEW_FILE_TITLE = 'toolbar.newFile';

let disk: Record<string, string>;
let writes: Array<[string, string]>;
let beforeWrite: () => { success: false; error: string } | void;
let openFile: ReturnType<typeof vi.fn>;
let saveDialog: ReturnType<typeof vi.fn>;

async function mount(type: 'article' | 'presentation' | 'book', open: string): Promise<void> {
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Projet',
      path: PROJECT,
      type,
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    chapters: [],
    bookSettings: { ...DEFAULT_BOOK_SETTINGS },
    loadState: { kind: 'ready', loadedAt: 'avant', path: PROJECT },
  });
  useEditorStore.setState({ filePath: open, content: disk[open], isDirty: false, editorFacade: null });
  await act(async () => {
    render(
      <>
        <AutoSave />
        <EditorPanel />
      </>
    );
  });
}

async function clickNewFile(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTitle(NEW_FILE_TITLE));
  });
}

async function answerConfirm(value: boolean): Promise<void> {
  await act(async () => {
    useDialogStore.getState().resolveConfirm(value);
    await vi.advanceTimersByTimeAsync(0);
  });
}

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const typeInEditor = (text: string) =>
  act(async () => {
    useEditorStore.getState().editorFacade?.setValue(text);
  });

const clickSave = () =>
  act(async () => {
    fireEvent.click(screen.getByTitle('toolbar.save'));
    await vi.advanceTimersByTimeAsync(0);
  });

const REFUSED = { success: false, error: 'Write access denied' } as const;

/** Une écriture retenue, refusée au moment où le test la libère. Les suivantes aboutissent. */
function heldRefusedWrite(): () => Promise<void> {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  window.electron.editor.saveFile = vi
    .fn(async (path: string, content: string) => {
      disk[path] = content;
      return { success: true };
    })
    .mockImplementationOnce(async () => {
      await gate;
      return REFUSED;
    }) as never;
  return () =>
    act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
}

beforeEach(() => {
  vi.useFakeTimers();
  disk = { [DOCUMENT]: ARTICLE, [SLIDES]: '# Diapo\n\n---\n\n## Une\n' };
  writes = [];
  beforeWrite = () => undefined;
  openFile = vi.fn(async () => ({ canceled: false, filePaths: [`${PROJECT}/context.md`] }));
  saveDialog = vi.fn(async () => ({ canceled: false, filePath: '/ailleurs/note.md' }));
  (window as unknown as { electron: unknown }).electron = {
    project: {
      readChapters: vi.fn(async () => ({ success: true, files: [] })),
      getChapters: vi.fn(async () => ({ success: true, chapters: [], unattached: [] })),
      createChapter: vi.fn(async () => ({ success: true })),
    },
    editor: {
      loadFile: vi.fn(async (path: string) => ({ success: true, content: disk[path] ?? '' })),
      saveFile: vi.fn(async (path: string, content: string) => {
        const verdict = beforeWrite();
        if (verdict) return verdict;
        writes.push([path, content]);
        disk[path] = content;
        return { success: true };
      }),
    },
    dialog: { openFile, saveFile: saveDialog },
    ipcRenderer: { on: () => undefined, removeListener: () => undefined },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useEditorStore.setState({ editorFacade: null, switchLock: null, bufferDetached: false } as never);
  useProjectStore.setState({ currentProject: null, chapters: [] });
  while (useDialogStore.getState().confirmOpen) useDialogStore.getState().resolveConfirm(false);
  while (useDialogStore.getState().alertOpen) useDialogStore.getState().closeAlert();
});

describe('« Nouveau fichier » dans un article ou une présentation', () => {
  it.each([
    ['article', DOCUMENT],
    ['presentation', SLIDES],
  ] as const)('%s : OK, puis 3,1 s : le fichier n’a pas bougé et le tampon est sans titre', async (type, path) => {
    const before = disk[path];
    await mount(type, path);

    await clickNewFile();
    expect(useDialogStore.getState().confirmMessage).toBe('toolbar.newFileConfirm');
    await answerConfirm(true);
    await wait(3100);

    expect(disk[path]).toBe(before);
    expect(writes).toEqual([]);
    expect(useEditorStore.getState().filePath).toBeNull();
    expect(useEditorStore.getState().isDirty).toBe(false);
  });

  it('la frappe suivante n’atteint jamais document.md', async () => {
    await mount('article', DOCUMENT);
    await clickNewFile();
    await answerConfirm(true);

    await typeInEditor('Nouvelle idée');
    await wait(3100);

    expect(disk[DOCUMENT]).toBe(ARTICLE);
    expect(writes).toEqual([]);
  });

  it('les frappes non enregistrées partent dans le fichier ouvert avant le tampon vide', async () => {
    await mount('article', DOCUMENT);
    await typeInEditor(`${ARTICLE}Dernière phrase.`);

    await clickNewFile();
    await answerConfirm(true);

    expect(disk[DOCUMENT]).toBe(`${ARTICLE}Dernière phrase.`);
    expect(useEditorStore.getState().filePath).toBeNull();
  });

  it('écriture refusée : l’auteur est prévenu et reste sur son fichier', async () => {
    await mount('article', DOCUMENT);
    await typeInEditor(`${ARTICLE}Dernière phrase.`);
    beforeWrite = () => ({ success: false, error: 'disque plein' });

    await clickNewFile();
    await answerConfirm(true);

    expect(useDialogStore.getState().alertMessage).toBe('toolbar.saveError');
    expect(useEditorStore.getState().filePath).toBe(DOCUMENT);
    expect(useEditorStore.getState().getLiveContent()).toBe(`${ARTICLE}Dernière phrase.`);
  });

  it('Annuler : rien ne bouge', async () => {
    await mount('article', DOCUMENT);

    await clickNewFile();
    await answerConfirm(false);
    await wait(3100);

    expect(disk[DOCUMENT]).toBe(ARTICLE);
    expect(useEditorStore.getState().filePath).toBe(DOCUMENT);
    expect(useEditorStore.getState().getLiveContent()).toBe(ARTICLE);
  });

  it('verrou posé : le message de l’opération, sans question ni écriture', async () => {
    await mount('article', DOCUMENT);
    await act(async () => {
      useEditorStore.getState().setSwitchLock('book.renumberInProgress');
    });

    await clickNewFile();

    expect(useDialogStore.getState().confirmOpen).toBe(false);
    expect(useDialogStore.getState().alertMessage).toBe('book.renumberInProgress');
    expect(useEditorStore.getState().filePath).toBe(DOCUMENT);
  });

  it('verrou posé pendant la question : le message de l’opération, et rien ne bouge', async () => {
    await mount('article', DOCUMENT);

    await clickNewFile();
    await act(async () => {
      useEditorStore.getState().setSwitchLock('book.renumberInProgress');
    });
    await answerConfirm(true);

    expect(useDialogStore.getState().alertMessage).toBe('book.renumberInProgress');
    expect(useEditorStore.getState().filePath).toBe(DOCUMENT);
  });

  it('tampon sans titre : pas la question du fichier ouvert, seulement celle de la perte', async () => {
    await mount('article', DOCUMENT);
    await clickNewFile();
    await answerConfirm(true);
    await typeInEditor('Une page.');

    await clickNewFile();

    expect(useDialogStore.getState().confirmMessage).toBe(i18n.t('editor.discardUntitledConfirm'));
    await answerConfirm(false);
    expect(useEditorStore.getState().getLiveContent()).toBe('Une page.');
  });
});

describe('« Nouveau fichier » dans un livre', () => {
  it('ajoute un chapitre, sans quitter le chapitre ouvert', async () => {
    disk[`${PROJECT}/chapters/a.md`] = '# A\n';
    await mount('book', `${PROJECT}/chapters/a.md`);

    await clickNewFile();

    expect(window.electron.project.createChapter).toHaveBeenCalledTimes(1);
    expect(useDialogStore.getState().confirmOpen).toBe(false);
    expect(useEditorStore.getState().filePath).toBe(`${PROJECT}/chapters/a.md`);
  });

  it('verrou posé : aucun chapitre pendant la renumérotation, et l’auteur le sait', async () => {
    disk[`${PROJECT}/chapters/a.md`] = '# A\n';
    await mount('book', `${PROJECT}/chapters/a.md`);
    await act(async () => {
      useEditorStore.getState().setSwitchLock('book.renumberInProgress');
    });

    await clickNewFile();

    expect(window.electron.project.createChapter).not.toHaveBeenCalled();
    expect(useDialogStore.getState().alertMessage).toBe('book.renumberInProgress');
  });
});

describe('Enregistrer un tampon sans titre', () => {
  it('passe l’option d’invite de remplacement, et ne propose aucun nom', async () => {
    await mount('article', DOCUMENT);
    await clickNewFile();
    await answerConfirm(true);
    await typeInEditor('Une page.');

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.save'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(saveDialog.mock.calls[0][0]).not.toHaveProperty('defaultPath');
    expect(saveDialog.mock.calls[0][0].properties).toContain('showOverwriteConfirmation');
  });

  // Le premier enregistrement d'un tampon sans titre : l'autosave n'y peut rien, et un
  // rejet dans le `catch` du bouton laissait l'auteur sans le moindre message.
  describe('quand l’écriture échoue', () => {
    let rejections: unknown[];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };

    async function untitledWith(text: string): Promise<void> {
      await mount('article', DOCUMENT);
      await clickNewFile();
      await answerConfirm(true);
      await typeInEditor(text);
    }

    beforeEach(() => {
      rejections = [];
      process.on('unhandledRejection', onRejection);
    });

    afterEach(() => {
      process.off('unhandledRejection', onRejection);
    });

    it('destination refusée : le message, et le texte reste dans le tampon', async () => {
      await untitledWith('Une page.');
      beforeWrite = () => ({ success: false, error: 'EACCES: permission denied' });

      await clickSave();

      expect(useDialogStore.getState().alertMessage).toBe('toolbar.saveError');
      expect(disk['/ailleurs/note.md']).toBeUndefined();
      expect(useEditorStore.getState().filePath).toBeNull();
      expect(useEditorStore.getState().getLiveContent()).toBe('Une page.');
      expect(rejections).toEqual([]);
    });

    it('le second essai écrit le fichier, et le tampon prend son chemin', async () => {
      await untitledWith('Une page.');
      beforeWrite = () => ({ success: false, error: 'EACCES: permission denied' });
      await clickSave();
      act(() => useDialogStore.getState().closeAlert());

      beforeWrite = () => undefined;
      await clickSave();

      expect(disk['/ailleurs/note.md']).toBe('Une page.');
      expect(useEditorStore.getState().filePath).toBe('/ailleurs/note.md');
      expect(useDialogStore.getState().alertOpen).toBe(false);
    });

    it('le dialogue lui-même en erreur : le même message', async () => {
      await untitledWith('Une page.');
      saveDialog.mockImplementation(async () => {
        throw new Error('dialogue refusé');
      });

      await clickSave();

      expect(useDialogStore.getState().alertMessage).toBe('toolbar.saveError');
      expect(useEditorStore.getState().getLiveContent()).toBe('Une page.');
      expect(rejections).toEqual([]);
    });

    // Tampon remplacé pendant l'écriture : l'auteur a répondu à la question de la perte,
    // et ce texte n'est plus à l'écran.
    it('tampon remplacé pendant l’écriture : son échec n’annonce rien, comme au menu', async () => {
      await untitledWith('Une page.');
      const finish = heldRefusedWrite();
      await clickSave();

      await act(async () => {
        await useEditorStore.getState().replaceBuffer({ kind: 'untitled', discardOutgoing: true }, 'new-document');
      });
      await finish();

      expect(useDialogStore.getState().alertOpen).toBe(false);
      expect(rejections).toEqual([]);
    });
  });
});

// Le menu et le bouton doivent dire la même chose : un échec qui n'a plus d'objet ne s'annonce
// à aucune des deux portes. Le main refuse réellement une écriture encore en vol quand le
// projet a changé, et l'alerte parlerait d'un document qui n'est plus à l'écran.
describe('Enregistrer un document ouvert, quand l’écriture échoue', () => {
  it('témoin : le message, et le texte reste', async () => {
    await mount('article', DOCUMENT);
    await typeInEditor('Une page.');
    beforeWrite = () => REFUSED;

    await clickSave();

    expect(useDialogStore.getState().alertMessage).toBe('toolbar.saveError');
    expect(useEditorStore.getState().getLiveContent()).toBe('Une page.');
    expect(disk[DOCUMENT]).toBe(ARTICLE);
  });

  it('témoin : un document propre au départ le dit aussi, son fichier n’est peut-être plus là', async () => {
    await mount('article', DOCUMENT);
    beforeWrite = () => REFUSED;

    await clickSave();

    expect(useDialogStore.getState().alertMessage).toBe('toolbar.saveError');
  });

  it('document remplacé pendant l’écriture : son échec n’annonce rien', async () => {
    await mount('article', DOCUMENT);
    const finish = heldRefusedWrite();
    await clickSave();

    await act(async () => {
      await useEditorStore.getState().replaceBuffer({ kind: 'detach' }, 'project-switch');
    });
    await finish();

    expect(useEditorStore.getState().bufferDetached).toBe(true);
    expect(useDialogStore.getState().alertOpen).toBe(false);
  });

  it('une autre écriture a tout mis sur le disque entre-temps : rien à annoncer', async () => {
    await mount('article', DOCUMENT);
    const finish = heldRefusedWrite();
    await typeInEditor('Une page.');
    await clickSave();

    await act(async () => {
      await useEditorStore.getState().saveFile();
    });
    expect(disk[DOCUMENT]).toBe('Une page.');
    await finish();

    expect(useDialogStore.getState().alertOpen).toBe(false);
  });
});

describe('Ouvrir, quand c’est le document ouvert qui ne s’écrit pas', () => {
  it('le message parle de l’enregistrement : le fichier demandé n’y est pour rien', async () => {
    await mount('article', DOCUMENT);
    await typeInEditor('Une page.');
    beforeWrite = () => REFUSED;

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.open'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(useDialogStore.getState().alertMessage).toBe('toolbar.saveError');
    expect(useEditorStore.getState().filePath).toBe(DOCUMENT);
    expect(useEditorStore.getState().getLiveContent()).toBe('Une page.');
  });
});

describe('les autres boutons de fichier sous le verrou', () => {
  it('Ouvrir dit la vraie raison, plus « fichier introuvable ou illisible »', async () => {
    await mount('article', DOCUMENT);
    await act(async () => {
      useEditorStore.getState().setSwitchLock('book.renumberInProgress');
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.open'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(openFile).toHaveBeenCalled();
    expect(useDialogStore.getState().alertMessage).toBe('book.renumberInProgress');
    expect(useEditorStore.getState().filePath).toBe(DOCUMENT);
  });

  it('Ouvrir un fichier qui n’est pas en UTF-8 : le refus dit quoi faire, et le document reste', async () => {
    await mount('article', DOCUMENT);
    window.electron.editor.loadFile = vi.fn(async () => ({
      success: false,
      code: 'unreadable',
      reason: 'encoding',
      error: 'pas UTF-8',
    })) as never;

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.open'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(useDialogStore.getState().alertMessage).toBe('editor.notUtf8');
    expect(useEditorStore.getState().filePath).toBe(DOCUMENT);
  });

  it('Enregistrer un tampon sans titre dit la vraie raison, et n’écrit rien', async () => {
    await mount('article', DOCUMENT);
    await clickNewFile();
    await answerConfirm(true);
    await typeInEditor('Une page.');
    await act(async () => {
      useEditorStore.getState().setSwitchLock('book.renumberInProgress');
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.save'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(saveDialog).toHaveBeenCalled();
    expect(useDialogStore.getState().alertMessage).toBe('book.renumberInProgress');
    expect(disk['/ailleurs/note.md']).toBeUndefined();
    expect(useEditorStore.getState().filePath).toBeNull();
  });
});

describe('la barre d’outils pendant un changement de projet', () => {
  async function detach(type: 'article' | 'book'): Promise<void> {
    await mount(type, DOCUMENT);
    await act(async () => {
      await useEditorStore.getState().replaceBuffer({ kind: 'detach' }, 'project-switch');
    });
  }

  it('Enregistrer n’ouvre aucun dialogue sur un document absent', async () => {
    await detach('article');

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.save'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(saveDialog).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(useDialogStore.getState().alertOpen).toBe(false);
  });

  it('Nouveau fichier, article : aucune question et aucun tampon', async () => {
    await detach('article');

    await clickNewFile();

    expect(useDialogStore.getState().confirmOpen).toBe(false);
    expect(useEditorStore.getState().bufferDetached).toBe(true);
  });

  it('Nouveau fichier, livre : aucun chapitre', async () => {
    await detach('book');

    await clickNewFile();

    expect(window.electron.project.createChapter).not.toHaveBeenCalled();
  });
});
