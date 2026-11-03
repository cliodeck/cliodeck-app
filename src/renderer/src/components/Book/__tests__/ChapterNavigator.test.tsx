// @vitest-environment jsdom
/**
 * Navigateur de chapitres (plan chapitres, Phase 2).
 *
 * Trois garanties vérifiées ici : l'ordre et la numérotation affichés, la
 * bascule qui passe TOUJOURS par `loadFile` (verrou anti-perte de la
 * Phase 0), et le retrait qui sort du manifeste sans toucher au fichier.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import type { ResolvedChapter, UnattachedFile } from '@backend/types/book';

import { ChapterNavigator } from '../ChapterNavigator';
import { replaceLeadingHeading } from '@/editor/outline';
import { useProjectStore } from '../../../stores/projectStore';
import { EditorFileError, useEditorStore } from '../../../stores/editorStore';
import { useDialogStore } from '../../../stores/dialogStore';
import { useManuscriptStore } from '../../../stores/manuscriptStore';
import type { EditorFacade } from '@/editor/facade';

const PROJECT_PATH = '/livre';

function chapter(over: Partial<ResolvedChapter> & { id: string }): ResolvedChapter {
  return {
    title: over.title ?? over.id,
    filePath: over.filePath ?? `chapters/${over.id}.md`,
    order: over.order ?? 0,
    kind: over.kind ?? 'chapter',
    ...over,
  };
}

function setupStore(
  chapters: ResolvedChapter[],
  unattached: UnattachedFile[] = []
): void {
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Danzig',
      path: PROJECT_PATH,
      type: 'book',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    chapters,
    unattachedFiles: unattached,
    currentChapterId: chapters[0]?.id ?? null,
  });
}

describe('ChapterNavigator', () => {
  let loadFile: ReturnType<typeof vi.fn>;
  let saveChapters: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    loadFile = vi.fn(async () => ({ status: 'replaced' }));
    saveChapters = vi.fn(async () => ({ success: true }));
    useEditorStore.setState({ loadFile, editorFacade: null } as never);
    (window as unknown as { electron: unknown }).electron = {
      project: {
        saveChapters,
        getChapters: vi.fn(async () => ({
          success: true,
          chapters: [],
          unattached: [],
        })),
        createChapter: vi.fn(async () => ({ success: true })),
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('affiche les chapitres dans l’ordre, seuls ceux du corps numérotés', () => {
    setupStore([
      chapter({ id: 'pref', title: 'Préface', kind: 'front', order: 0 }),
      chapter({ id: 'c1', title: 'Danzig en 1932', order: 1 }),
      chapter({ id: 'c2', title: 'Le Volkstag', order: 2 }),
    ]);
    render(<ChapterNavigator />);

    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Préface');
    expect(items[1]).toHaveTextContent('Danzig en 1932');
    expect(items[2]).toHaveTextContent('Le Volkstag');

    // La préface n'est pas numérotée ; les chapitres du corps le sont à
    // partir de 1 (arbitrage 2 : chapitres numérotés, sections non).
    expect(items[0].textContent).toContain('—');
    expect(items[1].textContent).toContain('1');
    expect(items[2].textContent).toContain('2');
  });

  it('ouvre un chapitre en passant par loadFile (bascule sûre)', async () => {
    setupStore([
      chapter({ id: 'c1', title: 'Un', order: 0 }),
      chapter({ id: 'c2', title: 'Deux', filePath: 'chapters/02.md', order: 1 }),
    ]);
    render(<ChapterNavigator />);

    await act(async () => {
      fireEvent.click(screen.getByText('Deux'));
    });

    // Chemin absolu = projet + chemin relatif du manifeste.
    expect(loadFile).toHaveBeenCalledWith(`${PROJECT_PATH}/chapters/02.md`);
    await waitFor(() =>
      expect(useProjectStore.getState().currentChapterId).toBe('c2')
    );
  });

  it('le chapitre déjà ouvert reste le chapitre courant (rien n’a été remplacé)', async () => {
    loadFile.mockResolvedValue({ status: 'unchanged' });
    setupStore([chapter({ id: 'c1', title: 'Un' }), chapter({ id: 'c2', title: 'Deux' })]);
    useProjectStore.setState({ currentChapterId: 'c1' });
    render(<ChapterNavigator />);

    await act(async () => {
      fireEvent.click(screen.getByText('Deux'));
    });

    expect(useProjectStore.getState().currentChapterId).toBe('c2');
  });

  it.each(['cancelled', 'superseded'] as const)(
    'bascule %s : le chapitre courant ne bouge pas, sans message',
    async (status) => {
      loadFile.mockResolvedValue({ status });
      setupStore([chapter({ id: 'c1', title: 'Un' }), chapter({ id: 'c2', title: 'Deux' })]);
      render(<ChapterNavigator />);

      await act(async () => {
        fireEvent.click(screen.getByText('Deux'));
      });

      expect(useProjectStore.getState().currentChapterId).toBe('c1');
      expect(useDialogStore.getState().alertOpen).toBe(false);
    }
  );

  it('verrou posé : la raison du refus, et le chapitre courant ne bouge pas', async () => {
    loadFile.mockResolvedValue({ status: 'locked', lock: 'book.renumberInProgress' });
    setupStore([chapter({ id: 'c1', title: 'Un' }), chapter({ id: 'c2', title: 'Deux' })]);
    render(<ChapterNavigator />);

    await act(async () => {
      fireEvent.click(screen.getByText('Deux'));
    });

    expect(useProjectStore.getState().currentChapterId).toBe('c1');
    expect(useDialogStore.getState().alertMessage).toBe('book.renumberInProgress');
    act(() => useDialogStore.getState().closeAlert());
  });

  it('chapitre qui n’est pas en UTF-8 : le refus tel quel, et le chapitre courant ne bouge pas', async () => {
    loadFile.mockRejectedValue(new EditorFileError('unreadable', 'encoding', 'Ce fichier n’est pas en UTF-8.'));
    setupStore([chapter({ id: 'c1', title: 'Un' }), chapter({ id: 'c2', title: 'Deux' })]);
    render(<ChapterNavigator />);

    await act(async () => {
      fireEvent.click(screen.getByText('Deux'));
    });

    expect(useProjectStore.getState().currentChapterId).toBe('c1');
    expect(useDialogStore.getState().alertMessage).toBe('Ce fichier n’est pas en UTF-8.');
    act(() => useDialogStore.getState().closeAlert());
  });

  it('la surbrillance suit le document ouvert, pas le dernier chapitre cliqué', async () => {
    setupStore([chapter({ id: 'c1', title: 'Un' }), chapter({ id: 'c2', title: 'Deux' })]);
    useEditorStore.setState({ filePath: `${PROJECT_PATH}/chapters/c1.md` });
    render(<ChapterNavigator />);
    const item = screen.getByText('Un').closest('li');
    expect(item).toHaveClass('active');

    // Un tampon sans titre : le chapitre n'est plus devant l'auteur.
    act(() => useEditorStore.setState({ filePath: null }));
    expect(item).not.toHaveClass('active');

    // Un autre fichier du projet (context.md, une note de lecture) : de même.
    act(() => useEditorStore.setState({ filePath: `${PROJECT_PATH}/context.md` }));
    expect(item).not.toHaveClass('active');
  });

  it('n’ouvre pas un chapitre dont le fichier a disparu', async () => {
    setupStore([chapter({ id: 'c1', title: 'Fantôme', missing: true })]);
    render(<ChapterNavigator />);

    await act(async () => {
      fireEvent.click(screen.getByText('Fantôme'));
    });

    expect(loadFile).not.toHaveBeenCalled();
  });

  it('réordonne en persistant le nouvel ordre', async () => {
    setupStore([
      chapter({ id: 'c1', title: 'Un', order: 0 }),
      chapter({ id: 'c2', title: 'Deux', order: 1 }),
    ]);
    render(<ChapterNavigator />);

    await act(async () => {
      fireEvent.click(screen.getAllByTitle('book.moveDown')[0]);
    });

    await waitFor(() => expect(saveChapters).toHaveBeenCalled());
    const sent = saveChapters.mock.calls[0][0].chapters as ResolvedChapter[];
    expect(sent.map((c) => c.id)).toEqual(['c2', 'c1']);
  });

  it('retire du manifeste après confirmation, sans effacer le fichier', async () => {
    setupStore([
      chapter({ id: 'c1', title: 'Un', order: 0 }),
      chapter({ id: 'c2', title: 'Deux', order: 1 }),
    ]);
    vi.spyOn(useDialogStore.getState(), 'showConfirm').mockResolvedValue(true);
    render(<ChapterNavigator />);

    await act(async () => {
      fireEvent.click(screen.getAllByTitle('book.removeChapter')[0]);
    });

    await waitFor(() => expect(saveChapters).toHaveBeenCalled());
    const sent = saveChapters.mock.calls[0][0].chapters as ResolvedChapter[];
    expect(sent.map((c) => c.id)).toEqual(['c2']);
    // Aucune API de suppression de fichier n'est appelée : le texte reste.
    expect(
      (window as unknown as { electron: { fs?: unknown } }).electron.fs
    ).toBeUndefined();
  });

  it('propose de rattacher un fichier trouvé hors manifeste', async () => {
    setupStore(
      [chapter({ id: 'c1', title: 'Un', order: 0 })],
      [{ filePath: 'chapters/99-oublie.md', suggestedTitle: 'Oublié' }]
    );
    render(<ChapterNavigator />);

    expect(screen.getByText('Oublié')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTitle('book.attach'));
    });

    await waitFor(() => expect(saveChapters).toHaveBeenCalled());
    const sent = saveChapters.mock.calls[0][0].chapters as ResolvedChapter[];
    expect(sent).toHaveLength(2);
    expect(sent[1].filePath).toBe('chapters/99-oublie.md');
    expect(sent[1].title).toBe('Oublié');
  });
});

describe('renommer un chapitre', () => {
  const OPEN_CHAPTER = `${PROJECT_PATH}/chapters/c1.md`;
  let text: string;
  let setValue: ReturnType<typeof vi.fn>;

  async function rename(title: string): Promise<void> {
    render(<ChapterNavigator />);
    fireEvent.doubleClick(screen.getByText('Un'));
    const input = screen.getByPlaceholderText('book.titlePlaceholder');
    fireEvent.change(input, { target: { value: title } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
  }

  beforeEach(() => {
    text = '# Un\n\nTexte.\n';
    setValue = vi.fn((next: string) => {
      text = next;
    });
    useEditorStore.setState({
      filePath: OPEN_CHAPTER,
      editorFacade: { getValue: () => text, setValue } as unknown as EditorFacade,
    });
    (window as unknown as { electron: unknown }).electron = {
      project: {
        saveChapters: vi.fn(async () => ({ success: true })),
        getChapters: vi.fn(async () => ({ success: true, chapters: [], unattached: [] })),
      },
    };
    setupStore([chapter({ id: 'c1', title: 'Un', order: 0 })]);
  });

  afterEach(() => {
    cleanup();
    useEditorStore.setState({ filePath: null, editorFacade: null });
    vi.restoreAllMocks();
  });

  it('le chapitre ouvert : son titre suit dans le texte', async () => {
    await rename('Un bis');

    expect(text).toBe('# Un bis\n\nTexte.\n');
  });

  it('un tampon sans titre sous un chapitre encore annoncé : son texte n’est pas touché', async () => {
    text = 'Une idée.\n';
    useEditorStore.setState({ filePath: null });

    await rename('Un bis');

    expect(setValue).not.toHaveBeenCalled();
    expect(text).toBe('Une idée.\n');
  });

  it('un autre fichier du projet est ouvert : son texte n’est pas touché', async () => {
    text = '# Notes\n';
    useEditorStore.setState({ filePath: `${PROJECT_PATH}/notes.md` });

    await rename('Un bis');

    expect(setValue).not.toHaveBeenCalled();
    expect(text).toBe('# Notes\n');
  });
});

describe('ChapterNavigator pendant une opération sur le manuscrit', () => {
  let loadFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    loadFile = vi.fn(async () => ({ status: 'replaced' }));
    useEditorStore.setState({ loadFile, editorFacade: null } as never);
    setupStore([
      chapter({ id: 'c1', title: 'Un', order: 0 }),
      chapter({ id: 'c2', title: 'Deux', filePath: 'chapters/02.md', order: 1 }),
    ]);
    (window as unknown as { electron: unknown }).electron = { project: {} };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useManuscriptStore.setState({ renumbering: false, exporting: false, info: {} });
    while (useDialogStore.getState().alertOpen) useDialogStore.getState().closeAlert();
  });

  it('refuse la bascule pendant une renumérotation et dit pourquoi', async () => {
    useManuscriptStore.setState({ renumbering: true });
    render(<ChapterNavigator />);

    await act(async () => {
      fireEvent.click(screen.getByText('Deux'));
    });

    expect(loadFile).not.toHaveBeenCalled();
    expect(useDialogStore.getState().alertMessage).toBe('book.renumberInProgress');
    expect(useProjectStore.getState().currentChapterId).toBe('c1');
  });

  it('ne déplace pas le curseur du chapitre ouvert quand la bascule est refusée', async () => {
    const revealLine = vi.fn();
    useEditorStore.setState({ editorFacade: { revealLine } as unknown as EditorFacade });
    useManuscriptStore.setState({
      renumbering: true,
      info: {
        'chapters/02.md': {
          stats: {} as never,
          outline: [{ level: 2, text: 'Section', line: 7, from: 0, to: 0 }] as never,
        },
      },
    });
    render(<ChapterNavigator />);

    fireEvent.click(screen.getAllByTitle('book.outlineToggle')[0]);
    await act(async () => {
      fireEvent.click(screen.getByText('Section'));
    });
    await act(async () => {
      useDialogStore.getState().closeAlert();
    });

    expect(loadFile).not.toHaveBeenCalled();
    expect(revealLine).not.toHaveBeenCalled();
  });

  it('laisse naviguer pendant un export, qui a lu au départ et peut durer des minutes', async () => {
    useManuscriptStore.setState({ exporting: true });
    render(<ChapterNavigator />);

    await act(async () => {
      fireEvent.click(screen.getByText('Deux'));
    });

    expect(loadFile).toHaveBeenCalledWith(`${PROJECT_PATH}/chapters/02.md`);
    expect(useDialogStore.getState().alertOpen).toBe(false);
  });
});

describe('ChapterNavigator pendant un changement de projet', () => {
  let createChapter: ReturnType<typeof vi.fn>;
  const loading = () =>
    act(async () => {
      useProjectStore.setState({ loadState: { kind: 'loading', path: '/autre/project.json' } });
    });

  beforeEach(() => {
    createChapter = vi.fn(async () => ({ success: true }));
    useEditorStore.setState({
      loadFile: vi.fn(async () => ({ status: 'superseded' })),
      editorFacade: null,
    } as never);
    (window as unknown as { electron: unknown }).electron = {
      project: {
        createChapter,
        saveChapters: vi.fn(async () => ({ success: true })),
        getChapters: vi.fn(async () => ({ success: true, chapters: [], unattached: [] })),
      },
    };
    setupStore(
      [chapter({ id: 'c1', title: 'Un', order: 0 }), chapter({ id: 'c2', title: 'Deux', order: 1 })],
      [{ filePath: 'chapters/brouillon.md' } as UnattachedFile]
    );
    useProjectStore.setState({ loadState: { kind: 'idle' } });
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ loadState: { kind: 'idle' } });
    vi.restoreAllMocks();
  });

  it('rien ne peut plus écrire dans le manifeste du projet qu’on quitte', async () => {
    render(<ChapterNavigator />);
    expect(screen.getByTitle('book.addChapter')).toBeEnabled();

    await loading();

    expect(screen.getByTitle('book.addChapter')).toBeDisabled();
    expect(screen.getByTitle('book.settings.title')).toBeDisabled();
    for (const button of screen.getAllByTitle('book.moveDown')) expect(button).toBeDisabled();
    for (const button of screen.getAllByTitle('book.removeChapter')) expect(button).toBeDisabled();
    expect(screen.getByTitle('book.attach')).toBeDisabled();
  });

  it('une saisie ouverte avant le changement n’ajoute aucun chapitre au projet quitté', async () => {
    render(<ChapterNavigator />);
    fireEvent.click(screen.getByTitle('book.addChapter'));
    const input = screen.getByPlaceholderText('book.titlePlaceholder');
    fireEvent.change(input, { target: { value: 'Chapitre fantôme' } });

    await loading();
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(createChapter).not.toHaveBeenCalled();
  });
});

describe('replaceLeadingHeading', () => {
  it('remplace le premier titre de niveau 1', () => {
    expect(replaceLeadingHeading('# Ancien\n\nTexte.\n', 'Nouveau')).toBe(
      '# Nouveau\n\nTexte.\n'
    );
  });

  it('ajoute un titre quand le fichier n’en a pas', () => {
    expect(replaceLeadingHeading('Texte sans titre.\n', 'Titre')).toBe(
      '# Titre\n\nTexte sans titre.\n'
    );
  });

  it('ignore les ## et cible le premier # de début de ligne', () => {
    const source = '## Sous-titre\n\nTexte.\n';
    expect(replaceLeadingHeading(source, 'T')).toBe(`# T\n\n${source}`);
  });

  it('ne prend pas un # de bloc de code pour le titre (levée en Phase 3)', () => {
    // La limite documentée en Phase 2 (renommage ligne à ligne) est levée :
    // `replaceLeadingHeading` s'appuie désormais sur l'arbre Lezer partagé
    // (`@/editor/outline`). Le bloc de code est intact et le titre est ajouté.
    const source = '```\n# pas un titre\n```\n';
    expect(replaceLeadingHeading(source, 'T')).toBe('# T\n\n```\n# pas un titre\n```\n');
  });
});
