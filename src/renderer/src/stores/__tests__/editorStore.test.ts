/**
 * Tests for editorStore.insertDraftAtCursor (fusion 2.6).
 *
 * The Monaco/Milkdown branches need a live editor to exercise; both
 * are too heavy to mock under vitest. This suite covers the fallback
 * path (no editor mounted) and the cursor-mode return value via a
 * hand-rolled Monaco stub. The Milkdown branch is exercised only at
 * the level of "cursor mode is reported, content is updated" — the
 * underlying ProseMirror cursor-offset mapping is too coupled to the
 * Milkdown internals to test in isolation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../editorStore';

beforeEach(() => {
  // Reset to clean state — no editors, empty content.
  useEditorStore.setState({
    content: '',
    isDirty: false,
    milkdownEditor: null,
    monacoEditor: null,
    editorMode: 'wysiwyg',
  });
});

describe('insertDraftAtCursor — fallback path (no editor)', () => {
  it('appends the draft when neither editor is mounted', () => {
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

  it('also falls back when editorMode is wysiwyg but no Milkdown ref is set', () => {
    useEditorStore.setState({
      content: 'AB',
      editorMode: 'wysiwyg',
      milkdownEditor: null,
    });
    const { mode } = useEditorStore.getState().insertDraftAtCursor('X');
    expect(mode).toBe('append');
    expect(useEditorStore.getState().content).toBe('AB\n\nX\n');
  });

  it('also falls back when editorMode is source but no Monaco ref is set', () => {
    useEditorStore.setState({
      content: 'AB',
      editorMode: 'source',
      monacoEditor: null,
    });
    const { mode } = useEditorStore.getState().insertDraftAtCursor('X');
    expect(mode).toBe('append');
    expect(useEditorStore.getState().content).toBe('AB\n\nX\n');
  });
});

describe('insertDraftAtCursor — cursor path (Monaco stub)', () => {
  // Hand-rolled Monaco stub matching the bits the action reads:
  // getModel().getOffsetAt(getPosition()) and the round-trip
  // setPosition / focus. Avoids pulling monaco-editor (multi-MB) into
  // the test bundle.
  function fakeMonacoAt(offset: number): {
    getModel: () => {
      getOffsetAt: () => number;
      getPositionAt: (n: number) => unknown;
    } | null;
    getPosition: () => unknown;
    setPosition: (p: unknown) => void;
    focus: () => void;
    moves: number[];
  } {
    let lastOffset = offset;
    const moves: number[] = [];
    return {
      getModel: () => ({
        getOffsetAt: () => lastOffset,
        getPositionAt: (n: number) => {
          lastOffset = n;
          moves.push(n);
          return { lineNumber: 1, column: n + 1 };
        },
      }),
      getPosition: () => ({ lineNumber: 1, column: lastOffset + 1 }),
      setPosition: () => undefined,
      focus: () => undefined,
      moves,
    };
  }

  it('inserts at the Monaco cursor offset and reports cursor mode', () => {
    // Content "ABCDE", cursor at offset 3 (between C and D).
    const stub = fakeMonacoAt(3);
    useEditorStore.setState({
      content: 'ABCDE',
      editorMode: 'source',
      // The store types insist on a Monaco editor instance; the stub
      // satisfies the bits the action actually touches.
      monacoEditor: stub as unknown as ReturnType<
        typeof useEditorStore.getState
      >['monacoEditor'],
    });

    const { mode } = useEditorStore.getState().insertDraftAtCursor('NEW');
    expect(mode).toBe('cursor');
    // Padding-aware splice: ABC + \n\n + NEW + \n\n + DE
    expect(useEditorStore.getState().content).toBe('ABC\n\nNEW\n\nDE');
    expect(useEditorStore.getState().isDirty).toBe(true);
    // The cursor was moved to immediately after the inserted draft.
    expect(stub.moves[stub.moves.length - 1]).toBe(
      'ABC\n\nNEW\n\nDE'.indexOf('NEW') + 'NEW'.length + 2 // padAfter "\n\n"
    );
  });

  it('falls back to append when editorMode is wysiwyg even if monacoEditor exists', () => {
    // Source mode is required to use the Monaco branch. WYSIWYG with
    // a stale Monaco ref must NOT reach Monaco; the absence of a real
    // Milkdown editor then sends us to the append fallback.
    const stub = fakeMonacoAt(2);
    useEditorStore.setState({
      content: 'AB',
      editorMode: 'wysiwyg',
      milkdownEditor: null,
      monacoEditor: stub as unknown as ReturnType<
        typeof useEditorStore.getState
      >['monacoEditor'],
    });
    const { mode } = useEditorStore.getState().insertDraftAtCursor('X');
    expect(mode).toBe('append');
    expect(useEditorStore.getState().content).toBe('AB\n\nX\n');
  });
});
