// @vitest-environment jsdom
/**
 * Aller à une occurrence quand l'éditeur refuse de changer de chapitre.
 *
 * Le refus du verrou devenait « search.error », et un refus de l'auteur ou une
 * demande dépassée rattachait quand même le chapitre courant au navigateur.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import type { ResolvedChapter } from '@backend/types/book';

import { ManuscriptSearch } from '../ManuscriptSearch';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';

const PROJECT = '/p/livre';
const A = `${PROJECT}/chapters/a.md`;

function chapterOf(id: string): ResolvedChapter {
  return { id, title: `Chapitre ${id}`, filePath: `chapters/${id}.md`, order: 0, kind: 'chapter' };
}

/** Lance la recherche et clique sur l'occurrence, qui est dans le chapitre b. */
async function goToHitInB(): Promise<void> {
  render(<ManuscriptSearch onClose={() => undefined} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Danzig' } });
  await act(async () => {
    fireEvent.submit(screen.getByRole('searchbox').closest('form') as HTMLFormElement);
  });
  await act(async () => {
    fireEvent.click(screen.getByTitle('search.goToLine'));
  });
}

beforeEach(() => {
  (window as unknown as { electron: unknown }).electron = {
    project: {
      readChapters: vi.fn(async () => ({
        success: true,
        files: [{ filePath: 'chapters/b.md', content: '# B\n\nDanzig en 1932.\n' }],
      })),
    },
    editor: {
      loadFile: vi.fn(async () => ({ success: true, content: '# B\n\nDanzig en 1932.\n' })),
    },
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
    chapters: [chapterOf('a'), chapterOf('b')],
    currentChapterId: 'a',
  });
  useEditorStore.setState({ filePath: A, content: '# A\n', isDirty: false, editorFacade: null });
});

afterEach(() => {
  cleanup();
  useEditorStore.setState({ switchLock: null } as never);
  useProjectStore.setState({ currentProject: null, chapters: [], currentChapterId: null });
});

describe('ManuscriptSearch : aller à une occurrence', () => {
  it('verrou posé : la vraie raison, et le chapitre courant ne bouge pas', async () => {
    useEditorStore.setState({ switchLock: 'book.renumberInProgress' } as never);

    await goToHitInB();

    expect(screen.getByText('book.renumberInProgress')).toBeInTheDocument();
    expect(screen.queryByText('search.error')).toBeNull();
    expect(useProjectStore.getState().currentChapterId).toBe('a');
    expect(useEditorStore.getState().filePath).toBe(A);
  });

  it('bascule refusée ou dépassée : le chapitre courant ne bouge pas, sans message', async () => {
    const realLoadFile = useEditorStore.getState().loadFile;
    useEditorStore.setState({ loadFile: async () => ({ status: 'cancelled' }) } as never);

    await goToHitInB();
    useEditorStore.setState({ loadFile: realLoadFile } as never);

    expect(useProjectStore.getState().currentChapterId).toBe('a');
    expect(screen.queryByText('search.error')).toBeNull();
  });

  it('chapitre qui n’est pas en UTF-8 : le refus dit quoi faire, et le chapitre courant ne bouge pas', async () => {
    window.electron.editor.loadFile = vi.fn(async () => ({
      success: false,
      code: 'unreadable',
      reason: 'encoding',
      error: 'pas UTF-8',
    })) as never;

    await goToHitInB();

    expect(screen.getByText('editor.notUtf8')).toBeInTheDocument();
    expect(screen.queryByText('search.error')).toBeNull();
    expect(useProjectStore.getState().currentChapterId).toBe('a');
  });

  it('témoin : la bascule aboutie rattache le chapitre', async () => {
    await goToHitInB();

    expect(useEditorStore.getState().filePath).toBe(`${PROJECT}/chapters/b.md`);
    expect(useProjectStore.getState().currentChapterId).toBe('b');
  });
});

describe('ManuscriptSearch : un chapitre illisible', () => {
  const search = async (): Promise<void> => {
    render(<ManuscriptSearch onClose={() => undefined} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Danzig' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('searchbox').closest('form') as HTMLFormElement);
    });
  };

  it('la recherche dit qu’elle est incomplète, et rend ce qu’elle a trouvé ailleurs', async () => {
    useProjectStore.setState({
      chapters: [chapterOf('a'), chapterOf('b'), { ...chapterOf('c'), title: 'Chapitre c' }],
    });
    window.electron.project.readChapters = vi.fn(async () => ({
      success: true,
      files: [
        { filePath: 'chapters/b.md', content: '# B\n\nDanzig en 1932.\n' },
        { filePath: 'chapters/c.md', reason: 'encoding', error: 'pas UTF-8' },
      ],
    })) as never;

    await search();

    expect(screen.getByText('book.readIncomplete')).toBeInTheDocument();
    expect(screen.getByTitle('search.goToLine')).toBeInTheDocument();
  });

  it('aucun résultat ailleurs : « aucun résultat » ne cache pas le chapitre non lu', async () => {
    window.electron.project.readChapters = vi.fn(async () => ({
      success: true,
      files: [{ filePath: 'chapters/b.md', reason: 'encoding', error: 'pas UTF-8' }],
    })) as never;

    await search();

    expect(screen.getByText('book.readIncomplete')).toBeInTheDocument();
    expect(screen.getByText('search.noResults')).toBeInTheDocument();
  });

  it('témoin : tout est lu, rien sur un résultat incomplet', async () => {
    await search();

    expect(screen.queryByText('book.readIncomplete')).toBeNull();
    expect(screen.getByTitle('search.goToLine')).toBeInTheDocument();
  });

  it('une nouvelle recherche après la conversion : le message est parti', async () => {
    const reading = vi.fn(async () => ({
      success: true,
      files: [{ filePath: 'chapters/b.md', reason: 'encoding', error: 'pas UTF-8' }],
    }));
    window.electron.project.readChapters = reading as never;
    await search();
    expect(screen.getByText('book.readIncomplete')).toBeInTheDocument();

    reading.mockResolvedValue({
      success: true,
      files: [{ filePath: 'chapters/b.md', content: '# B\n\nDanzig en 1932.\n' } as never],
    });
    await act(async () => {
      fireEvent.submit(screen.getByRole('searchbox').closest('form') as HTMLFormElement);
    });

    expect(screen.queryByText('book.readIncomplete')).toBeNull();
  });
});
