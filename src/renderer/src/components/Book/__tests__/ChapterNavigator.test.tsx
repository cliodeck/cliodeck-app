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
import { useEditorStore } from '../../../stores/editorStore';
import { useDialogStore } from '../../../stores/dialogStore';

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
    loadFile = vi.fn(async () => undefined);
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
