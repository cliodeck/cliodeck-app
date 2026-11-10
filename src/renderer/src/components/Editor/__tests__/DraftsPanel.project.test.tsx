// @vitest-environment jsdom
/**
 * Les brouillons dans la barre d'outils de l'Écriture : le compteur et le panneau ne montrent que
 * ceux du projet ouvert, et ceux d'avant la mise à jour, sans projet connu (S16-2-5, Q12).
 *
 * Trois réponses mises en brouillon dans A étaient listées dans B, sans mention de leur projet, et
 * « Insérer » les proposait dans le texte de B. Vrais EditorPanel, DraftsPanel et stores ; la vue
 * CM6 est réduite à sa façade, comme dans `EditorPanel.newFile.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';

import { EditorPanel } from '../EditorPanel';
import { useDraftsStore, type BrainstormDraft } from '../../../stores/draftsStore';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useDialogStore } from '../../../stores/dialogStore';

vi.mock('../CodeMirrorEditor', async () => {
  const React = await import('react');
  const { useEditorStore: store } = await import('../../../stores/editorStore');
  const CodeMirrorEditor = () => {
    React.useEffect(() => {
      store.getState().setEditorFacade({
        getValue: () => store.getState().content,
        setValue: () => undefined,
        onContentChange: () => () => undefined,
        onSelectionChange: () => () => undefined,
        getCursorOffset: () => 0,
      } as never);
      return () => store.getState().setEditorFacade(null);
    }, []);
    return null;
  };
  return { CodeMirrorEditor };
});

const A = '/projets/A';
const B = '/projets/B';

const draft = (id: string, content: string, projectPath?: string): BrainstormDraft => ({
  id,
  content,
  createdAt: '2026-11-09T10:00:00.000Z',
  source: { model: 'qwen3:8b', task: 'brainstorm' },
  ...(projectPath ? { projectPath } : {}),
});

const OF_A = [draft('a1', 'Réponse de A, une', A), draft('a2', 'Réponse de A, deux', A), draft('a3', 'Réponse de A, trois', A)];
const OLD = draft('ancien', 'Brouillon d’avant la mise à jour');

const counter = () => screen.getByTitle('drafts.title').querySelector('.toolbar-btn__count')?.textContent ?? '0';
const cards = () =>
  Array.from(document.querySelectorAll('.drafts-panel__card-title')).map((title) => title.textContent);

async function openIn(projectPath: string): Promise<void> {
  act(() => {
    useProjectStore.setState({
      currentProject: {
        id: projectPath,
        name: projectPath,
        path: projectPath,
        type: 'article',
        createdAt: new Date(),
        lastOpenedAt: new Date(),
      },
      chapters: [],
      bookSettings: { ...DEFAULT_BOOK_SETTINGS },
      loadState: { kind: 'ready', loadedAt: 'avant', path: projectPath },
    });
    useEditorStore.setState({ filePath: `${projectPath}/document.md`, content: '# Texte\n', isDirty: false });
  });
}

beforeEach(async () => {
  (window as unknown as { electron: unknown }).electron = {
    project: {
      readChapters: vi.fn(async () => ({ success: true, files: [] })),
      getChapters: vi.fn(async () => ({ success: true, chapters: [], unattached: [] })),
    },
    editor: {
      loadFile: vi.fn(async () => ({ success: true, content: '# Texte\n' })),
      saveFile: vi.fn(async () => ({ success: true })),
    },
    ipcRenderer: { on: () => () => undefined },
  };
  useDraftsStore.setState({ drafts: [...OF_A, OLD], isPanelOpen: true, proposedIds: [] });
  await openIn(A);
  await act(async () => {
    render(<EditorPanel />);
  });
});

afterEach(() => {
  cleanup();
  while (useDialogStore.getState().confirmOpen) useDialogStore.getState().resolveConfirm(false);
  useEditorStore.setState({ editorFacade: null, filePath: null, content: '', isDirty: false });
  useProjectStore.setState({ currentProject: null, chapters: [], loadState: { kind: 'idle' } });
  useDraftsStore.setState({ drafts: [], isPanelOpen: false, proposedIds: [] });
});

describe('dans le projet B', () => {
  it('les trois brouillons de A ne sont ni comptés ni listés ; celui d’avant la mise à jour l’est', async () => {
    await openIn(B);

    expect(counter()).toBe('1');
    expect(cards()).toEqual(['Brouillon d’avant la mise à jour']);
    expect(screen.queryAllByText(/Réponse de A/)).toEqual([]);
  });

  it('« Vider la file » ne jette que ce qui est affiché : ceux de A restent', async () => {
    await openIn(B);

    fireEvent.click(screen.getByTitle('drafts.clearAll'));
    expect(useDialogStore.getState().confirmMessage).toBe('drafts.clearConfirm');
    await act(async () => {
      useDialogStore.getState().resolveConfirm(true);
    });

    expect(cards()).toEqual([]);
    expect(useDraftsStore.getState().drafts.map((d) => d.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('jeter celui d’avant la mise à jour le retire partout', async () => {
    await openIn(B);

    const card = screen
      .getByText('Brouillon d’avant la mise à jour', { selector: '.drafts-panel__card-title' })
      .closest('.drafts-panel__card') as HTMLElement;
    fireEvent.click(within(card).getByTitle('drafts.discardTitle'));
    await openIn(A);

    expect(cards()).toEqual(['Réponse de A, une', 'Réponse de A, deux', 'Réponse de A, trois']);
    expect(counter()).toBe('3');
  });
});

describe('de retour dans A', () => {
  it('ses brouillons sont là, avec celui d’avant la mise à jour', async () => {
    await openIn(B);
    await openIn(A);

    expect(counter()).toBe('4');
    expect(cards()).toEqual([
      'Réponse de A, une',
      'Réponse de A, deux',
      'Réponse de A, trois',
      'Brouillon d’avant la mise à jour',
    ]);
  });
});
