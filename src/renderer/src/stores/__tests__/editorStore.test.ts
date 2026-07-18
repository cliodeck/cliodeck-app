/**
 * Tests for editorStore.insertDraftAtCursor (fusion 2.6, migration CM6).
 *
 * L'éditeur réel exige une EditorView ; la façade est stubée avec les
 * seules méthodes que l'action lit. Trois chemins : proposition (Phase 4,
 * façade avec propose), insertion directe (façade sans propose), et
 * fallback append (aucun éditeur monté).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../editorStore';
import type { EditorFacade } from '@/editor/facade';
import type { Proposal } from '@/editor/proposals';

beforeEach(() => {
  useEditorStore.setState({
    content: '',
    isDirty: false,
    editorFacade: null,
  });
});

function fakeFacade(
  content: string,
  cursor: number,
  withPropose: boolean
): {
  facade: EditorFacade;
  calls: { setValue: Array<{ text: string; cursor?: number }>; proposals: Array<Partial<Proposal>> };
} {
  const calls = {
    setValue: [] as Array<{ text: string; cursor?: number }>,
    proposals: [] as Array<Partial<Proposal>>,
  };
  let current = content;
  const facade: EditorFacade = {
    engine: 'cm6',
    getValue: () => current,
    getCursorOffset: () => cursor,
    getSelectionText: () => null,
    replaceSelection: () => undefined,
    setValue: (text, cursorOffset) => {
      current = text;
      calls.setValue.push({ text, cursor: cursorOffset });
    },
    appendText: (text) => {
      current += text;
    },
    revealLine: () => undefined,
    focus: () => undefined,
    onContentChange: () => () => undefined,
    ...(withPropose
      ? {
          propose: (p: Partial<Proposal>) => {
            calls.proposals.push(p);
            return true;
          },
        }
      : {}),
  };
  return { facade, calls };
}

describe('insertDraftAtCursor — fallback path (no editor)', () => {
  it('appends the draft when no editor is mounted', () => {
    useEditorStore.setState({ content: 'existing' });
    const { mode } = useEditorStore.getState().insertDraftAtCursor('NEW');
    expect(mode).toBe('append');
    expect(useEditorStore.getState().content).toBe('existing\n\nNEW\n');
    expect(useEditorStore.getState().isDirty).toBe(true);
  });

  it('handles an empty document by writing the draft alone', () => {
    const { mode } = useEditorStore.getState().insertDraftAtCursor('NEW');
    expect(mode).toBe('append');
    expect(useEditorStore.getState().content).toBe('NEW');
  });
});

describe('insertDraftAtCursor — contrat propositionnel (Phase 4)', () => {
  it('soumet une proposition d’insertion au curseur, sans toucher au document', () => {
    const { facade, calls } = fakeFacade('ABCDE', 3, true);
    useEditorStore.setState({ content: 'ABCDE', editorFacade: facade });

    const { mode } = useEditorStore.getState().insertDraftAtCursor('NEW');
    expect(mode).toBe('cursor');
    expect(calls.proposals).toHaveLength(1);
    const p = calls.proposals[0];
    expect(p.category).toBe('brainstorm-draft');
    expect(p.original).toBe('');
    expect(p.range?.from).toBe(p.range?.to);
    // Le segment proposé contient le draft avec son padding de bloc.
    expect(p.proposed).toContain('NEW');
    // Aucune écriture directe : le document ne change qu'à l'acceptation.
    expect(calls.setValue).toHaveLength(0);
    expect(facade.getValue()).toBe('ABCDE');
  });
});

describe('insertDraftAtCursor — façade sans propositions (défensif)', () => {
  it('insère directement au curseur et synchronise le store', () => {
    const { facade, calls } = fakeFacade('ABCDE', 3, false);
    useEditorStore.setState({ content: 'ABCDE', editorFacade: facade });

    const { mode } = useEditorStore.getState().insertDraftAtCursor('NEW');
    expect(mode).toBe('cursor');
    expect(calls.setValue).toHaveLength(1);
    // Padding-aware splice: ABC + \n\n + NEW + \n\n + DE
    expect(calls.setValue[0].text).toBe('ABC\n\nNEW\n\nDE');
    expect(useEditorStore.getState().content).toBe('ABC\n\nNEW\n\nDE');
    expect(useEditorStore.getState().isDirty).toBe(true);
  });
});
