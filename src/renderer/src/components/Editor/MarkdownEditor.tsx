import React, { useRef, useEffect } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type { editor, Position } from 'monaco-editor';
import type { EditorFacade } from '@/editor/facade';
import { normalizeInsertPayload, wrapLegacyProvenance } from './insert-payload';
import { useEditorStore } from '../../stores/editorStore';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { useTheme } from '../../hooks/useTheme';
import './MarkdownEditor.css';

/**
 * Implémentation Monaco de la façade éditeur-agnostique (plan CM6, Phase 1).
 * Les Slides et le store passent par elle plutôt que par l'API Monaco
 * directe, pour que CM6 puisse prendre le relais derrière le flag.
 */
function createMonacoFacade(ed: editor.IStandaloneCodeEditor): EditorFacade {
  return {
    engine: 'monaco',
    getValue: () => ed.getValue(),
    getCursorOffset: () => {
      const model = ed.getModel();
      const pos = ed.getPosition();
      return model && pos ? model.getOffsetAt(pos) : 0;
    },
    getSelectionText: () => {
      const model = ed.getModel();
      const sel = ed.getSelection();
      if (!model || !sel || sel.isEmpty()) return null;
      return model.getValueInRange(sel);
    },
    replaceSelection: (text) => {
      const sel = ed.getSelection();
      if (!sel) return;
      ed.executeEdits('facade', [{ range: sel, text }]);
      ed.focus();
    },
    setValue: (text, cursorOffset) => {
      const model = ed.getModel();
      if (!model) return;
      ed.executeEdits('facade', [{ range: model.getFullModelRange(), text }]);
      if (cursorOffset !== undefined) {
        const bounded = Math.max(0, Math.min(cursorOffset, text.length));
        ed.setPosition(model.getPositionAt(bounded));
      }
    },
    appendText: (text) => {
      const model = ed.getModel();
      if (!model) return;
      const lastLine = model.getLineCount();
      const lastCol = model.getLineMaxColumn(lastLine);
      ed.executeEdits('facade', [
        {
          range: {
            startLineNumber: lastLine,
            startColumn: lastCol,
            endLineNumber: lastLine,
            endColumn: lastCol,
          },
          text,
        },
      ]);
    },
    revealLine: (lineNumber) => {
      ed.revealLineInCenter(lineNumber);
      ed.setPosition({ lineNumber, column: 1 });
      ed.focus();
    },
    focus: () => ed.focus(),
    onContentChange: (callback) => {
      const disposable = ed.onDidChangeModelContent(() =>
        callback(ed.getValue())
      );
      return () => disposable.dispose();
    },
  };
}

export const MarkdownEditor: React.FC = () => {
  const { content, setContent, settings, setMonacoEditor, setEditorFacade } = useEditorStore();
  useBibliographyStore(); // Keep store subscription active
  const { currentTheme } = useTheme();
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  // Listen for insert text commands from bibliography.
  // Phase 4 : le main émet { text, metadata? } sans marqueurs ; le
  // comportement hérité (enveloppe cliodeck-gen pour le contenu IA) est
  // reconstruit ici — Monaco/Milkdown sont gelés jusqu'à la Phase 5.
  useEffect(() => {
    const unsubscribe = window.electron.editor.onInsertText((raw: unknown) => {
      const text = wrapLegacyProvenance(normalizeInsertPayload(raw));
      if (text && editorRef.current) {
        const selection = editorRef.current.getSelection();
        if (selection) {
          editorRef.current.executeEdits('insert-citation', [
            {
              range: selection,
              text: text,
            },
          ]);
          // Move cursor to end of inserted text
          const newPosition = {
            lineNumber: selection.startLineNumber,
            column: selection.startColumn + text.length,
          };
          editorRef.current.setPosition(newPosition);
          editorRef.current.focus();
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Store Monaco editor reference in store and cleanup on unmount
  useEffect(() => {
    return () => {
      setMonacoEditor(null);
      setEditorFacade(null);
    };
  }, [setMonacoEditor, setEditorFacade]);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    setMonacoEditor(editor);
    setEditorFacade(createMonacoFacade(editor));

    // Configure markdown language
    monaco.languages.setLanguageConfiguration('markdown', {
      wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
    });

    // Add keyboard shortcuts for formatting
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => {
      useEditorStore.getState().insertFormatting('bold');
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => {
      useEditorStore.getState().insertFormatting('italic');
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => {
      useEditorStore.getState().insertFormatting('link');
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Quote, () => {
      useEditorStore.getState().insertFormatting('citation');
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyT, () => {
      useEditorStore.getState().insertFormatting('table');
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => {
      useEditorStore.getState().insertFormatting('footnote');
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyQ, () => {
      useEditorStore.getState().insertFormatting('blockquote');
    });

    // Preview disabled
    // editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
    //   useEditorStore.getState().togglePreview();
    // });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => {
      useEditorStore.getState().toggleStats();
    });

    // Add custom citation autocomplete
    monaco.languages.registerCompletionItemProvider('markdown', {
      provideCompletionItems: (model: editor.ITextModel, position: Position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        // Trigger on "[@"
        const textUntilPosition = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });

        if (textUntilPosition.endsWith('[@')) {
          // Get citations from bibliography store (using getState for non-React context)
          const currentCitations = useBibliographyStore.getState().citations;

          if (currentCitations.length === 0) {
            return {
              suggestions: [
                {
                  label: 'Aucune citation',
                  kind: monaco.languages.CompletionItemKind.Text,
                  insertText: '',
                  range: range,
                  documentation: 'Importez votre bibliographie depuis le panneau Bibliographie',
                },
              ],
            };
          }

          const citationSuggestions = currentCitations.map(citation => {
            const documentationText = [
              `${citation.author} (${citation.year})`,
              citation.title,
              citation.journal || citation.publisher || citation.booktitle || '',
            ].filter(Boolean).join('\n');

            return {
              label: `@${citation.id}`,
              kind: monaco.languages.CompletionItemKind.Reference,
              insertText: `${citation.id}]`,
              range: range,
              documentation: documentationText,
              detail: citation.shortTitle || citation.title,
              sortText: `${citation.author}_${citation.year}`,
            };
          });

          return {
            suggestions: citationSuggestions,
          };
        }

        return { suggestions: [] };
      },
    });
  };

  const handleEditorChange = (value: string | undefined) => {
    setContent(value || '');
  };

  // Font family mapping
  const getFontFamily = () => {
    switch (settings.fontFamily) {
      case 'system':
        return "'SF Mono', 'Monaco', 'Consolas', 'Ubuntu Mono', monospace";
      case 'jetbrains':
        return "'JetBrains Mono', 'Consolas', monospace";
      case 'fira':
        return "'Fira Code', 'Consolas', monospace";
      case 'source':
        return "'Source Code Pro', 'Consolas', monospace";
      case 'cascadia':
        return "'Cascadia Code', 'Consolas', monospace";
      default:
        return "'SF Mono', 'Monaco', 'Consolas', 'Ubuntu Mono', monospace";
    }
  };

  return (
    <div className="markdown-editor">
      <Editor
        height="100%"
        defaultLanguage="markdown"
        value={content}
        onChange={handleEditorChange}
        onMount={handleEditorDidMount}
        theme={currentTheme === 'dark' ? 'vs-dark' : 'light'}
        options={{
          fontSize: settings.fontSize,
          wordWrap: settings.wordWrap ? 'on' : 'off',
          minimap: { enabled: settings.showMinimap },
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          insertSpaces: true,
          formatOnPaste: true,
          formatOnType: true,
          rulers: [80, 120],
          renderWhitespace: 'selection',
          cursorBlinking: 'smooth',
          smoothScrolling: true,
          fontFamily: getFontFamily(),
          fontLigatures: settings.fontFamily !== 'system',
        }}
      />
    </div>
  );
};
