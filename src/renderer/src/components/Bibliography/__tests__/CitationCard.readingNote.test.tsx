// @vitest-environment jsdom
/**
 * « Ouvrir la note de lecture » pendant que l'éditeur est verrouillé.
 *
 * `loadFile` rend désormais son refus au lieu de le lever : sans lecture de ce
 * statut, le clic ne ferait plus rien, en silence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

import { CitationCard } from '../CitationCard';
import { useEditorStore } from '../../../stores/editorStore';
import { useBibliographyStore, type Citation } from '../../../stores/bibliographyStore';
import { useDialogStore } from '../../../stores/dialogStore';

const NOTE = '/p/reading-notes/dupont2020.md';
const citation = {
  id: 'dupont2020',
  type: 'book',
  author: 'Dupont',
  year: '2020',
  title: 'Un titre',
} as Citation;

async function clickOpenNote(): Promise<void> {
  render(<CitationCard citation={citation} />);
  await act(async () => {
    fireEvent.click(screen.getByText('Dupont'));
  });
  await act(async () => {
    fireEvent.click(screen.getByTitle('bibliography.createReadingNote'));
  });
}

beforeEach(() => {
  (window as unknown as { electron: unknown }).electron = {
    editor: { loadFile: vi.fn(async () => ({ success: true, content: '# Note\n' })) },
  };
  useBibliographyStore.setState({ openReadingNote: async () => NOTE, readingNotes: [] } as never);
  useEditorStore.setState({ filePath: '/p/document.md', content: '', isDirty: false, editorFacade: null });
});

afterEach(() => {
  cleanup();
  useEditorStore.setState({ switchLock: null } as never);
  while (useDialogStore.getState().alertOpen) useDialogStore.getState().closeAlert();
});

/** Saisit une étiquette dans la fiche dépliée, comme l'auteur : texte puis Entrée. */
async function addTag(tag: string): Promise<void> {
  useBibliographyStore.setState({ citations: [citation] } as never);
  render(<CitationCard citation={citation} />);
  await act(async () => {
    fireEvent.click(screen.getByText('Dupont'));
  });
  const input = screen.getByPlaceholderText('tagManager.add…');
  fireEvent.change(input, { target: { value: tag } });
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter' });
  });
}

describe('CitationCard : étiqueter la note de lecture', () => {
  const stubSetTags = (response: unknown): void => {
    (window as unknown as { electron: { bibliography: unknown } }).electron.bibliography = {
      readingNotes: { setTags: vi.fn(async () => response) },
    };
  };

  it('note qui n’est pas en UTF-8 : le refus dit quoi faire, et l’étiquette n’apparaît pas', async () => {
    stubSetTags({ success: false, code: 'unreadable', reason: 'encoding', error: 'pas UTF-8' });

    await addTag('lu');

    expect(useDialogStore.getState().alertMessage).toBe('bibliography.readingNoteNotUtf8');
    expect(useBibliographyStore.getState().readingNotes).toEqual([]);
    expect(screen.queryByText('lu')).toBeNull();
  });

  it('autre échec : le message générique, avec l’erreur', async () => {
    stubSetTags({ success: false, error: 'EACCES' });

    await addTag('lu');

    expect(useDialogStore.getState().alertMessage).toBe('bibliography.readingNoteError');
  });

  it('témoin : l’étiquette s’affiche, sans alerte', async () => {
    stubSetTags({ success: true, note: { file: NOTE, citekey: 'dupont2020', tags: ['lu'] } });

    await addTag('lu');

    expect(useDialogStore.getState().alertOpen).toBe(false);
    expect(useBibliographyStore.getState().readingNotes).toEqual([
      { file: NOTE, citekey: 'dupont2020', tags: ['lu'] },
    ]);
  });
});

describe('CitationCard : ouvrir la note de lecture', () => {
  it('verrou posé : la raison du refus, et le document ouvert ne bouge pas', async () => {
    useEditorStore.setState({ switchLock: 'book.renumberInProgress' } as never);

    await clickOpenNote();

    expect(useDialogStore.getState().alertMessage).toBe('book.renumberInProgress');
    expect(useEditorStore.getState().filePath).toBe('/p/document.md');
  });

  it('note qui n’est pas en UTF-8 : le refus dit quoi faire, et le document ouvert ne bouge pas', async () => {
    window.electron.editor.loadFile = vi.fn(async () => ({
      success: false,
      code: 'unreadable',
      reason: 'encoding',
      error: 'pas UTF-8',
    })) as never;

    await clickOpenNote();

    expect(useDialogStore.getState().alertMessage).toBe('editor.notUtf8');
    expect(useEditorStore.getState().filePath).toBe('/p/document.md');
  });

  it('témoin : sans verrou, la note s’ouvre', async () => {
    await clickOpenNote();

    expect(useEditorStore.getState().filePath).toBe(NOTE);
    expect(useDialogStore.getState().alertOpen).toBe(false);
  });
});
