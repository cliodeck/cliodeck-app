// @vitest-environment jsdom
/**
 * Renumérotation d'un livre et bascule de chapitre.
 *
 * Le chapitre ouvert était lu en deux temps de part et d'autre d'un `await` :
 * ouvrir B pendant la lecture du disque rangeait le texte vivant de B sous la
 * clé de A, et `chapters/A.md` partait sur le disque avec le texte de B, sous un
 * message de succès. Le texte de A n'existait plus nulle part.
 *
 * Vrais EditorPanel, ChapterNavigator, autosave et stores ; seuls le disque (en mémoire,
 * derrière l'IPC) et la vue CM6 sont simulés. La fausse vue suit la vraie
 * (`CodeMirrorEditor`) : recréée sur `documentVersion`, façade retirée
 * au démontage, `setValue` sans effet une fois détruite, `isDirty` posé à chaque
 * modification, ce qui rend l'autosave visible dans ces tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { EXPORT_TIME_LIMIT_MS } from '@backend/types/export-limits';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';
import type { ResolvedChapter } from '@backend/types/book';

import { EditorPanel } from '../EditorPanel';
import { useAutoSave } from '../../../hooks/useAutoSave';
import { useEditorStore } from '../../../stores/editorStore';
import { useManuscriptStore } from '../../../stores/manuscriptStore';
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
          // Comme la vraie vue : toute modification du document arme l'autosave.
          store.setState({ isDirty: true });
        },
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

const PROJECT = '/p/livre';
const pathOf = (rel: string) => `${PROJECT}/chapters/${rel}.md`;
const A = pathOf('a');
const B = pathOf('b');
const C = pathOf('c');

// Déjà numérotés dans l'ordre : sans bascule, rien à réécrire.
const ORDERED = {
  [A]: '# A\n\nTexte A[^1] suite[^2].\n\n[^1]: une\n\n[^2]: deux\n',
  [B]: '# B\n\nTexte B[^3] suite[^4].\n\n[^3]: trois\n\n[^4]: quatre\n',
};
// Les trois chapitres changent, dans l'ordre du manifeste.
const DISORDERED = {
  [A]: '# A\n\nTexte A[^2] suite[^3].\n\n[^2]: une\n\n[^3]: deux\n',
  [B]: '# B\n\nTexte B[^7].\n\n[^7]: trois\n',
  [C]: '# C\n\nTexte C[^9].\n\n[^9]: quatre\n',
};

let disk: Record<string, string>;
/** Chapitres que le main refuse de lire, et sa raison. */
let unreadableOnDisk: Map<string, string>;
let writes: Array<[string, string]>;
/** Attente insérée dans la prochaine lecture du disque, puis retirée. */
let nextRead: Promise<void> | null;
/** Appelé avant chaque écriture du disque, qu'il peut retenir ou faire échouer. */
let beforeWrite: (path: string) => Promise<{ success: false; error: string } | void> | void;

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function chapterOf(path: string, order: number): ResolvedChapter {
  const name = path.replace(/^.*\/|\.md$/g, '');
  return { id: name, title: name, filePath: `chapters/${name}.md`, order, kind: 'chapter' };
}

async function openBook(files: Record<string, string>, open: string = A): Promise<void> {
  disk = { ...files };
  unreadableOnDisk = new Map();
  writes = [];
  nextRead = null;
  beforeWrite = () => undefined;
  (window as unknown as { electron: unknown }).electron = {
    project: {
      readChapters: vi.fn(async (data: { filePaths: string[] }) => {
        const gate = nextRead;
        nextRead = null;
        if (gate) await gate;
        return {
          success: true,
          files: data.filePaths.map((filePath) =>
            unreadableOnDisk.has(filePath)
              ? { filePath, reason: unreadableOnDisk.get(filePath), error: 'illisible' }
              : { filePath, content: disk[`${PROJECT}/${filePath}`] }
          ),
        };
      }),
      getChapters: vi.fn(async () => ({ success: true, chapters: [], unattached: [] })),
    },
    editor: {
      loadFile: vi.fn(async (path: string) => ({ success: true, content: disk[path] })),
      saveFile: vi.fn(async (path: string, content: string) => {
        const verdict = await beforeWrite(path);
        if (verdict) return verdict;
        writes.push([path, content]);
        disk[path] = content;
        return { success: true };
      }),
    },
    ipcRenderer: { on: () => () => undefined },
  };
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Livre',
      path: PROJECT,
      type: 'book',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    chapters: Object.keys(files).map(chapterOf),
    bookSettings: { ...DEFAULT_BOOK_SETTINGS },
    currentChapterId: chapterOf(open, 0).id,
    loadState: { kind: 'ready', loadedAt: 'avant', path: PROJECT },
  });
  useEditorStore.setState({
    filePath: open,
    content: files[open],
    isDirty: false,
    editorFacade: null,
  });
  await act(async () => {
    render(
      <>
        <AutoSave />
        <EditorPanel />
      </>
    );
  });
}

/** Clic sur Renuméroter, la lecture du disque étant retenue jusqu'à `release()`. */
async function clickRenumberWhileReading(): Promise<() => Promise<void>> {
  const gate = deferred();
  nextRead = gate.promise;
  await act(async () => {
    fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
  });
  return () =>
    act(async () => {
      gate.release();
    });
}

/** Une vue fraîche sur un autre fichier, sans passer par `loadFile` et son verrou. */
function switchBypassingLock(path: string): void {
  useEditorStore.setState((s) => ({
    filePath: path,
    content: disk[path],
    documentVersion: s.documentVersion + 1,
  }));
}

const alertMessage = () => useDialogStore.getState().alertMessage;
const live = () => useEditorStore.getState().getLiveContent();
const locks = () => ({
  renumbering: useManuscriptStore.getState().renumbering,
  switchLock: useEditorStore.getState().switchLock,
});
const FREE = { renumbering: false, switchLock: null };
const LOCKED = { status: 'locked', lock: 'book.renumberInProgress' };

beforeEach(() => {
  useManuscriptStore.setState({ renumbering: false, exporting: false, info: {} });
  useEditorStore.setState({ switchLock: null } as never);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useEditorStore.setState({ editorFacade: null, switchLock: null } as never);
  useProjectStore.setState({ currentProject: null, chapters: [] });
  while (useDialogStore.getState().alertOpen) useDialogStore.getState().closeAlert();
});

describe('renumérotation : un chapitre illisible', () => {
  it.each(['encoding', 'absent', 'permission'])(
    'fermé et illisible (%s) : refus, aucune écriture, et le chapitre ouvert ne bouge pas',
    async (reason) => {
      await openBook(DISORDERED);
      unreadableOnDisk.set('chapters/b.md', reason);
      const before = { ...disk };

      await act(async () => {
        fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
      });

      expect(alertMessage()).toBe('book.renumberUnreadable');
      expect(writes).toEqual([]);
      expect(disk).toEqual(before);
      expect(live()).toBe(DISORDERED[A]);
      expect(useEditorStore.getState().isDirty).toBe(false);
      expect(locks()).toEqual(FREE);
    }
  );
});

describe('renumérotation : un chapitre disparu depuis l’ouverture', () => {
  it('le refus met le manifeste à jour : le clic suivant passe, comme à la réouverture', async () => {
    await openBook(DISORDERED);
    const chaptersOnDisk = Object.keys(DISORDERED).map(chapterOf);
    window.electron.project.getChapters = vi.fn(async () => ({
      success: true,
      chapters: chaptersOnDisk.map((c) => (c.id === 'b' ? { ...c, missing: true } : c)),
      unattached: [],
    })) as never;
    unreadableOnDisk.set('chapters/b.md', 'absent');

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });
    expect(alertMessage()).toBe('book.renumberUnreadable');
    expect(writes).toEqual([]);
    expect(window.electron.project.getChapters).toHaveBeenCalledWith(PROJECT);
    await act(async () => {
      useDialogStore.getState().closeAlert();
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });

    expect(alertMessage()).toBe('book.renumberDone');
    expect(writes.map(([path]) => path).sort()).toEqual([A, C]);
    expect(disk[C]).toBe('# C\n\nTexte C[^3].\n\n[^3]: quatre\n');
    expect(locks()).toEqual(FREE);
  });

  it('un chapitre encore là mais illisible : le manifeste n’a rien à apprendre', async () => {
    await openBook(DISORDERED);
    unreadableOnDisk.set('chapters/b.md', 'encoding');

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });

    expect(alertMessage()).toBe('book.renumberUnreadable');
    expect(window.electron.project.getChapters).not.toHaveBeenCalled();
  });
});

describe('renumérotation sans bascule', () => {
  it('écrit chaque chapitre dans son fichier, le chapitre ouvert par l’éditeur', async () => {
    await openBook(DISORDERED);

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });

    expect(alertMessage()).toBe('book.renumberDone');
    expect(disk[A]).toBe('# A\n\nTexte A[^1] suite[^2].\n\n[^1]: une\n\n[^2]: deux\n');
    expect(disk[B]).toBe('# B\n\nTexte B[^3].\n\n[^3]: trois\n');
    expect(disk[C]).toBe('# C\n\nTexte C[^4].\n\n[^4]: quatre\n');
    expect(live()).toBe(disk[A]);
  });

  it('dit que rien n’est à faire quand tout est déjà dans l’ordre', async () => {
    await openBook(ORDERED);

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });

    expect(alertMessage()).toBe('book.renumberNoChange');
    expect(writes).toEqual([]);
  });
});

describe('bascule pendant la lecture du disque', () => {
  it('refuse loadFile : le fichier de A ne reçoit jamais le texte de B', async () => {
    await openBook(ORDERED);
    const release = await clickRenumberWhileReading();

    let refusal: unknown = null;
    await act(async () => {
      refusal = await useEditorStore.getState().loadFile(B);
    });
    await release();

    expect(writes).toEqual([]);
    expect(disk[A]).toBe(ORDERED[A]);
    expect(refusal).toEqual(LOCKED);
    expect(useEditorStore.getState().filePath).toBe(A);
    expect(alertMessage()).toBe('book.renumberNoChange');
  });

  it('refuse le clic du navigateur avec le message de l’opération en cours', async () => {
    await openBook(ORDERED);
    const release = await clickRenumberWhileReading();

    await act(async () => {
      fireEvent.click(screen.getByText('b'));
    });

    expect(useEditorStore.getState().filePath).toBe(A);
    expect(alertMessage()).toBe('book.renumberInProgress');

    await release();
    expect(writes).toEqual([]);
  });

  it('verrou contourné : abandon sans aucune écriture, et l’auteur est prévenu', async () => {
    await openBook(DISORDERED);
    const release = await clickRenumberWhileReading();

    await act(async () => {
      switchBypassingLock(B);
    });
    await release();

    expect(writes).toEqual([]);
    expect(alertMessage()).toBe('book.renumberInterrupted');
    expect(locks()).toEqual(FREE);
  });

  it('verrou contourné, rien à réécrire : l’auteur est prévenu quand même', async () => {
    await openBook(ORDERED);
    const release = await clickRenumberWhileReading();

    await act(async () => {
      switchBypassingLock(B);
    });
    await release();

    expect(writes).toEqual([]);
    expect(alertMessage()).toBe('book.renumberInterrupted');
  });

  it('projet remplacé sans chapitre ouvert : abandon, rien n’est écrit', async () => {
    await openBook(DISORDERED);
    await act(async () => {
      useEditorStore.setState((s) => ({
        filePath: null,
        documentVersion: s.documentVersion + 1,
      }));
    });
    const release = await clickRenumberWhileReading();

    await act(async () => {
      useProjectStore.setState({
        currentProject: { ...useProjectStore.getState().currentProject!, path: '/p/autre' },
      });
    });
    await release();

    expect(writes).toEqual([]);
    expect(alertMessage()).toBe('book.renumberInterrupted');
  });

  it('frappe pendant la lecture : abandon, le texte tapé reste dans l’éditeur', async () => {
    await openBook(DISORDERED);
    const release = await clickRenumberWhileReading();

    const typed = `${DISORDERED[A]}\nTapé pendant la lecture.\n`;
    await act(async () => {
      useEditorStore.getState().editorFacade?.setValue(typed);
    });
    await release();

    expect(live()).toBe(typed);
    expect(writes).toEqual([]);
    expect(alertMessage()).toBe('book.renumberInterrupted');
  });

  it('vue recréée sur le même fichier : l’écriture passe par la nouvelle façade', async () => {
    await openBook(DISORDERED);
    const release = await clickRenumberWhileReading();

    await act(async () => {
      useEditorStore.setState((s) => ({ documentVersion: s.documentVersion + 1 }));
    });
    await release();

    expect(alertMessage()).toBe('book.renumberDone');
    expect(disk[A]).toContain('Texte A[^1] suite[^2]');
    expect(live()).toBe(disk[A]);
  });

  it('éditeur démonté pendant l’attente : le chapitre ouvert est renuméroté quand même', async () => {
    await openBook(DISORDERED);
    const release = await clickRenumberWhileReading();

    await act(async () => {
      useEditorStore.getState().setEditorFacade(null);
    });
    await release();

    expect(alertMessage()).toBe('book.renumberDone');
    expect(disk[A]).toContain('Texte A[^1] suite[^2]');
  });
});

describe('bascule pendant la boucle d’écriture', () => {
  it('s’arrête et remet chaque fichier à son texte, sans passer par l’éditeur basculé', async () => {
    await openBook(DISORDERED);
    let switched = false;
    beforeWrite = async (path) => {
      // Le chapitre ouvert vient d'être écrit : la bascule tombe juste après.
      if (path === B && !switched) {
        switched = true;
        switchBypassingLock(C);
      }
    };

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });

    expect(alertMessage()).toBe('book.renumberInterrupted');
    // Le texte de A retrouve son fichier ; C, désormais ouvert, garde le sien.
    expect(disk[A]).toBe(DISORDERED[A]);
    expect(disk[C]).toBe(DISORDERED[C]);
    expect(disk[B]).toBe(DISORDERED[B]);
    expect(live()).toBe(DISORDERED[C]);
    expect(locks()).toEqual(FREE);
  });
});

describe('bascule partie avant le clic sur Renuméroter', () => {
  it('refusée à son arrivée : l’opération aboutit, chaque chapitre garde son texte', async () => {
    await openBook(DISORDERED);
    const typed = `${DISORDERED[A]}Tapé avant le clic.\n`;
    await act(async () => {
      useEditorStore.getState().editorFacade?.setValue(typed);
    });
    // `loadFile(B)` attend l'écriture du texte sortant de A, qui reste suspendue.
    const outgoing = deferred();
    const renumbered = deferred();
    let writesOfA = 0;
    beforeWrite = async (path) => {
      if (path !== A) return;
      writesOfA += 1;
      await (writesOfA === 1 ? outgoing : renumbered).promise;
    };
    let refusal: unknown = 'en attente';
    void useEditorStore
      .getState()
      .loadFile(B)
      .then((outcome) => {
        refusal = outcome;
      });

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });
    expect(writesOfA).toBe(2);
    await act(async () => {
      outgoing.release();
    });
    await act(async () => {
      renumbered.release();
    });

    expect(refusal).toEqual(LOCKED);
    expect(useEditorStore.getState().filePath).toBe(A);
    expect(alertMessage()).toBe('book.renumberDone');
    expect(disk[A]).toBe(
      '# A\n\nTexte A[^1] suite[^2].\n\n[^1]: une\n\n[^2]: deux\nTapé avant le clic.\n'
    );
    expect(disk[B]).toBe('# B\n\nTexte B[^3].\n\n[^3]: trois\n');
    expect(useEditorStore.getState().content).toBe(disk[A]);
    expect(live()).toBe(disk[A]);
    expect(locks()).toEqual(FREE);
  });
});

describe('document remplacé pendant l’écriture du chapitre ouvert', () => {
  it('Cmd+N est refusé : le chapitre reste ouvert, et l’opération aboutit', async () => {
    await openBook(DISORDERED);
    const stuck = deferred();
    let first = true;
    beforeWrite = async (path) => {
      if (path === A && first) {
        first = false;
        await stuck.promise;
      }
    };

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });
    let refusal: unknown = null;
    await act(async () => {
      refusal = await useEditorStore.getState().createNewFile();
    });
    await act(async () => {
      stuck.release();
    });

    expect(refusal).toEqual(LOCKED);
    expect(useEditorStore.getState().filePath).toBe(A);
    expect(alertMessage()).toBe('book.renumberDone');
    expect(disk[A]).toBe('# A\n\nTexte A[^1] suite[^2].\n\n[^1]: une\n\n[^2]: deux\n');
  });

  it('verrou contourné : la réponse de l’écriture ne remplit pas le nouveau tampon', async () => {
    await openBook(DISORDERED);
    const stuck = deferred();
    let first = true;
    beforeWrite = async (path) => {
      if (path === A && first) {
        first = false;
        await stuck.promise;
      }
    };

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });
    await act(async () => {
      useEditorStore.setState((s) => ({
        filePath: null,
        content: '',
        isDirty: false,
        documentVersion: s.documentVersion + 1,
      }));
    });
    await act(async () => {
      stuck.release();
    });

    expect(useEditorStore.getState().content).toBe('');
    expect(useEditorStore.getState().filePath).toBeNull();
    expect(alertMessage()).toBe('book.renumberInterrupted');
    expect(disk).toEqual(DISORDERED);
  });
});

describe('projet remplacé pendant la boucle d’écriture', () => {
  it('ne restaure pas dans le fichier de même nom de l’autre projet', async () => {
    await openBook(DISORDERED);
    const other = '/p/autre/chapters/a.md';
    const otherText = '# A de l’autre livre\n';
    let switched = false;
    beforeWrite = async (path) => {
      if (path === B && !switched) {
        switched = true;
        disk[other] = otherText;
        useProjectStore.setState({
          currentProject: { ...useProjectStore.getState().currentProject!, path: '/p/autre' },
        });
        switchBypassingLock(other);
      }
    };

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });

    expect(alertMessage()).toBe('book.renumberInterrupted');
    expect(disk[A]).toBe(DISORDERED[A]);
    expect(disk[other]).toBe(otherText);
    expect(live()).toBe(otherText);
  });
});

describe('les verrous', () => {
  it('sont posés pendant l’opération, puis relâchés sans attendre la fin de l’alerte', async () => {
    await openBook(ORDERED);
    const release = await clickRenumberWhileReading();
    expect(locks()).toEqual({ renumbering: true, switchLock: 'book.renumberInProgress' });

    await release();

    expect(alertMessage()).toBe('book.renumberNoChange');
    expect(locks()).toEqual(FREE);
  });

  it('une alerte tierce pendant l’attente ne les retient pas', async () => {
    await openBook(DISORDERED);
    const release = await clickRenumberWhileReading();

    void useDialogStore.getState().showAlert('bibliography.pdfDownloadedAndIndexed');
    await release();

    // L'alerte tierce est en tête de file, personne ne l'a fermée.
    expect(alertMessage()).toBe('bibliography.pdfDownloadedAndIndexed');
    expect(locks()).toEqual(FREE);
    expect(useManuscriptStore.getState().manuscriptBusyReason()).toBeUndefined();

    await act(async () => {
      useDialogStore.getState().closeAlert();
    });
    expect(alertMessage()).toBe('book.renumberDone');
  });

  it('sont relâchés après un échec d’écriture, et le manuscrit est remis en état', async () => {
    await openBook(DISORDERED);
    beforeWrite = async (path) => {
      if (path === C) return { success: false, error: 'disque plein' };
    };

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });

    expect(alertMessage()).toBe('book.renumberError');
    expect(locks()).toEqual(FREE);
    expect(disk).toEqual(DISORDERED);
    expect(live()).toBe(DISORDERED[A]);

    await act(async () => {
      useDialogStore.getState().closeAlert();
    });
    await act(async () => {
      await useEditorStore.getState().loadFile(B);
    });
    expect(useEditorStore.getState().filePath).toBe(B);
  });

  it('une relecture finale qui traîne ne retient ni eux ni le message de fin', async () => {
    await openBook(DISORDERED);
    beforeWrite = async (path) => {
      // Dernière écriture : la relecture qui suit ne répondra pas.
      if (path === C) nextRead = new Promise<void>(() => undefined);
    };

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });

    expect(alertMessage()).toBe('book.renumberDone');
    expect(locks()).toEqual(FREE);
  });

  it('un projet en cours d’ouverture désactive le bouton : ils ne se chevauchent pas', async () => {
    await openBook(DISORDERED);
    await act(async () => {
      useProjectStore.setState({ loadState: { kind: 'loading', path: '/p/autre' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });

    expect(screen.getByTitle('toolbar.renumberFootnotes')).toBeDisabled();
    expect(locks()).toEqual({ renumbering: false, switchLock: null });
    expect(alertMessage()).toBe('');
  });
});

describe('remise en état après un échec d’écriture', () => {
  const RENUMBERED_A = '# A\n\nTexte A[^1] suite[^2].\n\n[^1]: une\n\n[^2]: deux\n';
  const REFUSED = { success: false, error: 'refusé' } as const;

  const clickRenumber = () =>
    act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });
  const waitForAutosave = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(useEditorStore.getState().settings.autoSaveDelay);
    });
  const type = (text: string) => useEditorStore.getState().editorFacade?.setValue(text);

  /** Clic sur Renuméroter, l'écriture de C restant suspendue, puis refusée à `fail()`. */
  async function clickRenumberHoldingC(): Promise<() => Promise<void>> {
    const stuck = deferred();
    beforeWrite = async (path) => {
      if (path !== C) return;
      await stuck.promise;
      return REFUSED;
    };
    await clickRenumber();
    return () =>
      act(async () => {
        stuck.release();
      });
  }

  it('écriture du chapitre ouvert refusée : le tampon revient, l’autosave n’écrit pas le texte renuméroté', async () => {
    await openBook(DISORDERED);
    let first = true;
    beforeWrite = async (path) => {
      if (path === A && first) {
        first = false;
        return REFUSED;
      }
    };
    vi.useFakeTimers();

    await clickRenumber();

    expect(alertMessage()).toBe('book.renumberError');
    expect(live()).toBe(DISORDERED[A]);
    expect(locks()).toEqual(FREE);

    await waitForAutosave();
    expect(disk).toEqual(DISORDERED);
    expect(live()).toBe(DISORDERED[A]);
  });

  it('écritures refusées partout : le manuscrit est réellement inchangé, et le message reste juste', async () => {
    await openBook(DISORDERED);
    beforeWrite = async () => REFUSED;

    await clickRenumber();

    expect(alertMessage()).toBe('book.renumberError');
    expect(disk).toEqual(DISORDERED);
    expect(live()).toBe(DISORDERED[A]);
  });

  it('frappe pendant l’écriture de B, échec sur C : le texte tapé reste et atteint le disque', async () => {
    await openBook(DISORDERED);
    const typed = `${RENUMBERED_A}\nTapé pendant l’écriture.\n`;
    beforeWrite = async (path) => {
      if (path === B) type(typed);
      if (path === C) return REFUSED;
    };
    vi.useFakeTimers();

    await clickRenumber();

    // Le chapitre garde son texte : il n'est donc pas « inchangé ».
    expect(alertMessage()).toBe('book.renumberInterrupted');
    expect(live()).toBe(typed);
    expect(disk[B]).toBe(DISORDERED[B]);
    expect(disk[C]).toBe(DISORDERED[C]);
    expect(locks()).toEqual(FREE);

    await waitForAutosave();
    expect(disk[A]).toBe(typed);
    expect(live()).toBe(typed);
  });

  it('frappe pendant l’écriture refusée du chapitre ouvert : le texte tapé reste', async () => {
    await openBook(DISORDERED);
    const typed = `${RENUMBERED_A}\nTapé pendant l’écriture.\n`;
    let first = true;
    beforeWrite = async (path) => {
      if (path === A && first) {
        first = false;
        type(typed);
        return REFUSED;
      }
    };
    vi.useFakeTimers();

    await clickRenumber();

    expect(alertMessage()).toBe('book.renumberInterrupted');
    expect(live()).toBe(typed);
    expect(disk[B]).toBe(DISORDERED[B]);

    await waitForAutosave();
    expect(disk[A]).toBe(typed);
  });

  it('annulation par l’auteur : le tampon a déjà le texte d’origine, la remise en état suit', async () => {
    await openBook(DISORDERED);
    beforeWrite = async (path) => {
      if (path === B) type(DISORDERED[A]);
      if (path === C) return REFUSED;
    };

    await clickRenumber();

    expect(alertMessage()).toBe('book.renumberError');
    expect(disk).toEqual(DISORDERED);
    expect(live()).toBe(DISORDERED[A]);
  });

  it('bascule vers un chapitre déjà écrit, sans frappe : il retrouve son texte', async () => {
    await openBook(DISORDERED);
    const fail = await clickRenumberHoldingC();

    await act(async () => {
      switchBypassingLock(B);
    });
    expect(live()).toBe(disk[B]);
    expect(live()).not.toBe(DISORDERED[B]);
    await fail();

    expect(alertMessage()).toBe('book.renumberError');
    expect(disk).toEqual(DISORDERED);
    expect(live()).toBe(DISORDERED[B]);
  });

  it('bascule vers un chapitre déjà écrit, frappe : le texte tapé reste, les autres reviennent', async () => {
    await openBook(DISORDERED);
    const fail = await clickRenumberHoldingC();

    await act(async () => {
      switchBypassingLock(B);
    });
    const typed = `${live()}\nTapé après la bascule.\n`;
    await act(async () => {
      type(typed);
    });
    await fail();

    expect(alertMessage()).toBe('book.renumberInterrupted');
    expect(live()).toBe(typed);
    expect(disk[A]).toBe(DISORDERED[A]);
  });

  it('restauration refusée sur un autre chapitre : le message ne dit pas le manuscrit intact', async () => {
    await openBook(DISORDERED, B);
    let writesOfA = 0;
    beforeWrite = async (path) => {
      if (path === C) return REFUSED;
      if (path === A && ++writesOfA === 2) return REFUSED;
    };

    await clickRenumber();

    expect(alertMessage()).toBe('book.renumberRestoreFailed');
    expect(disk[A]).toBe(RENUMBERED_A);
    // La suite de la remise en état n'est pas abandonnée pour autant.
    expect(disk[B]).toBe(DISORDERED[B]);
    expect(live()).toBe(DISORDERED[B]);
    expect(locks()).toEqual(FREE);
  });

  it('restauration rejetée par l’IPC : même message, et non une erreur de plus', async () => {
    await openBook(DISORDERED, B);
    let writesOfA = 0;
    beforeWrite = async (path) => {
      if (path === C) return REFUSED;
      if (path === A && ++writesOfA === 2) throw new Error('canal coupé');
    };

    await clickRenumber();

    expect(alertMessage()).toBe('book.renumberRestoreFailed');
    expect(disk[B]).toBe(DISORDERED[B]);
  });

  it('restauration refusée du chapitre ouvert : le tampon revient, le message reste honnête', async () => {
    await openBook(DISORDERED);
    let writesOfA = 0;
    beforeWrite = async (path) => {
      if (path === C) return REFUSED;
      if (path === A && ++writesOfA === 2) return REFUSED;
    };

    await clickRenumber();

    expect(alertMessage()).toBe('book.renumberRestoreFailed');
    expect(disk[A]).toBe(RENUMBERED_A);
    expect(disk[B]).toBe(DISORDERED[B]);
    expect(live()).toBe(DISORDERED[A]);
  });

  it('interruption puis restauration refusée : l’échec de restauration prime sur l’interruption', async () => {
    await openBook(DISORDERED);
    let writesOfA = 0;
    let switched = false;
    beforeWrite = async (path) => {
      if (path === B && !switched) {
        switched = true;
        switchBypassingLock(C);
      }
      if (path === A && ++writesOfA === 2) return REFUSED;
    };

    await clickRenumber();

    expect(alertMessage()).toBe('book.renumberRestoreFailed');
    expect(disk[B]).toBe(DISORDERED[B]);
    expect(live()).toBe(DISORDERED[C]);
  });
});

describe('un disque qui ne répond plus', () => {
  const advanceToLimit = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(EXPORT_TIME_LIMIT_MS);
    });

  it('lecture sans réponse : les verrous tombent à la limite, rien n’est écrit au retour', async () => {
    await openBook(DISORDERED);
    vi.useFakeTimers();
    const release = await clickRenumberWhileReading();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPORT_TIME_LIMIT_MS - 1);
    });
    expect(locks()).toEqual({ renumbering: true, switchLock: 'book.renumberInProgress' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(locks()).toEqual(FREE);
    expect(alertMessage()).toBe('book.renumberTimedOut');

    // Le disque revient : l'opération abandonnée ne reprend pas derrière l'auteur.
    await release();
    expect(writes).toEqual([]);
  });

  it('écriture sans réponse : au retour, ni suite ni restauration sur ce qui a pu changer', async () => {
    await openBook(DISORDERED);
    const stuck = deferred();
    beforeWrite = async (path) => {
      if (path === B) await stuck.promise;
    };
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });
    expect(writes.map(([path]) => path)).toEqual([A]);

    await advanceToLimit();
    expect(locks()).toEqual(FREE);
    expect(alertMessage()).toBe('book.renumberTimedOut');

    // L'auteur a repris A pendant que B restait suspendu : restaurer l'écraserait.
    const edited = '# A\n\nRepris après la limite.\n';
    await act(async () => {
      useEditorStore.getState().editorFacade?.setValue(edited);
      await useEditorStore.getState().saveFile();
    });
    await act(async () => {
      stuck.release();
    });

    expect(disk[A]).toBe(edited);
    expect(live()).toBe(edited);
    expect(writes.map(([path]) => path)).toEqual([A, A, B]);
  });

  it('écriture du chapitre ouvert sans réponse, bascule après la limite : le miroir reste celui du document ouvert', async () => {
    await openBook(DISORDERED);
    const stuck = deferred();
    let first = true;
    beforeWrite = async (path) => {
      if (path === A && first) {
        first = false;
        await stuck.promise;
      }
    };
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });
    await advanceToLimit();
    expect(locks()).toEqual(FREE);

    await act(async () => {
      await useEditorStore.getState().loadFile(B);
    });
    await act(async () => {
      stuck.release();
    });

    expect(useEditorStore.getState().filePath).toBe(B);
    expect(useEditorStore.getState().content).toBe(DISORDERED[B]);
    expect(useEditorStore.getState().isDirty).toBe(false);

    // Une vue se crée sur le miroir (aller-retour de mode, par exemple) : elle
    // montrait le texte de A sous le chemin de B, et l'autosave l'écrivait là.
    await act(async () => {
      useEditorStore.setState((s) => ({ documentVersion: s.documentVersion + 1 }));
    });
    expect(live()).toBe(DISORDERED[B]);
    await act(async () => {
      useEditorStore.getState().editorFacade?.setValue(`${live()}Frappe.\n`);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(useEditorStore.getState().settings.autoSaveDelay);
    });
    expect(disk[B]).toBe(`${DISORDERED[B]}Frappe.\n`);
  });

  it('écriture qui échoue après la limite : pas de restauration non plus', async () => {
    await openBook(DISORDERED);
    const stuck = deferred();
    beforeWrite = async (path) => {
      if (path !== B) return;
      await stuck.promise;
      return { success: false, error: 'disque mort' };
    };
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });
    await advanceToLimit();
    const renumberedA = disk[A];

    await act(async () => {
      stuck.release();
    });

    // Sans frappe : seule la limite retient la remise en état de A.
    expect(writes.map(([path]) => path)).toEqual([A]);
    expect(disk[A]).toBe(renumberedA);
    expect(live()).toBe(renumberedA);
  });

  it('chapitre non ouvert repris après la limite, échec au retour du disque : le texte repris reste', async () => {
    await openBook(DISORDERED, B);
    const stuck = deferred();
    beforeWrite = async (path) => {
      if (path !== C) return;
      await stuck.promise;
      return { success: false, error: 'disque mort' };
    };
    vi.useFakeTimers();

    // A puis B (ouvert) sont écrits, C reste suspendu.
    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });
    await advanceToLimit();
    expect(locks()).toEqual(FREE);

    // L'auteur ouvre A, le reprend, l'enregistre et revient sur B : la garde de
    // frappe ne voit que le chapitre ouvert, seule la limite protège encore A.
    const edited = '# A\n\nRepris après la limite.\n';
    await act(async () => {
      await useEditorStore.getState().loadFile(A);
    });
    await act(async () => {
      useEditorStore.getState().editorFacade?.setValue(edited);
      await useEditorStore.getState().saveFile();
    });
    await act(async () => {
      await useEditorStore.getState().loadFile(B);
    });
    await act(async () => {
      stuck.release();
    });

    expect(disk[A]).toBe(edited);
    expect(writes.map(([path]) => path)).toEqual([A, B, A]);
  });

  it('restauration suspendue à la limite : elle ne reprend pas au retour du disque', async () => {
    await openBook(DISORDERED, B);
    const stuck = deferred();
    let writesOfA = 0;
    beforeWrite = async (path) => {
      if (path === C) return { success: false, error: 'disque plein' };
      if (path === A && ++writesOfA === 2) await stuck.promise;
    };
    vi.useFakeTimers();

    // A puis B (ouvert) sont écrits, C échoue, la remise en état reste sur A.
    await act(async () => {
      fireEvent.click(screen.getByTitle('toolbar.renumberFootnotes'));
    });
    await advanceToLimit();
    expect(locks()).toEqual(FREE);

    // L'auteur reprend B, l'enregistre et le quitte : B était le suivant à remettre.
    const edited = '# B\n\nRepris après la limite.\n';
    await act(async () => {
      useEditorStore.getState().editorFacade?.setValue(edited);
      await useEditorStore.getState().saveFile();
    });
    await act(async () => {
      await useEditorStore.getState().loadFile(C);
    });
    await act(async () => {
      stuck.release();
    });

    expect(disk[B]).toBe(edited);
    expect(live()).toBe(DISORDERED[C]);
  });
});
