import React, { useEffect, useRef } from 'react';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language';

/**
 * Éditeur YAML CM6 minimal pour la configuration (recettes). Contrairement
 * au wrapper de prose, un `value` contrôlé simple suffit ici : petits
 * documents, resynchronisation externe rare (chargement d'une recette).
 */
interface YamlEditorProps {
  value: string;
  onChange: (value: string | undefined) => void;
  readOnly?: boolean;
  height?: string;
}

const yamlTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--bg-panel)',
    color: 'var(--text-primary)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { caretColor: 'var(--color-accent)' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-panel)',
    color: 'var(--text-tertiary)',
    border: 'none',
  },
});

export const YamlEditor: React.FC<YamlEditorProps> = ({
  value,
  onChange,
  readOnly = false,
  height = '100%',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment()).current;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          lineNumbers(),
          yaml(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          yamlTheme,
          readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
      parent: container,
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resynchronisation externe (chargement d'une autre recette).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly, readOnlyCompartment]);

  return <div ref={containerRef} style={{ height, overflow: 'auto' }} />;
};
