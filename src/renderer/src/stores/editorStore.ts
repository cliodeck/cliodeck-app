import { create } from 'zustand';
import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import type { editor } from 'monaco-editor';
import { logger } from '../utils/logger';

// MARK: - Types

export interface EditorSettings {
  fontSize: number;
  theme: 'light' | 'dark';
  wordWrap: boolean;
  showPreview: boolean;
  previewPosition: 'right' | 'bottom';
  showMinimap: boolean;
  fontFamily: string;
  autoSave: boolean;
  autoSaveDelay: number; // in milliseconds
  defaultEditorMode: 'wysiwyg' | 'source'; // Issue #12: éditeur par défaut
}

interface EditorState {
  // Content
  content: string;
  filePath: string | null;
  isDirty: boolean;

  // Settings
  settings: EditorSettings;

  // Preview
  showPreview: boolean;

  // Editor mode
  editorMode: 'wysiwyg' | 'source';

  // Pending footnote scroll position (to scroll to definition after insertion)
  pendingFootnoteScroll: number | null;

  // Milkdown editor reference
  milkdownEditor: Editor | null;

  // Monaco editor reference
  monacoEditor: editor.IStandaloneCodeEditor | null;

  // Actions
  setContent: (content: string) => void;
  loadFile: (filePath: string) => Promise<void>;
  saveFile: () => Promise<void>;
  saveFileAs: (filePath: string) => Promise<void>;
  saveCurrentFile: () => Promise<void>;
  createNewFile: () => void;

  updateSettings: (settings: Partial<EditorSettings>) => void;
  togglePreview: () => void;
  toggleStats: () => void;
  toggleEditorMode: () => void;
  setEditorMode: (mode: 'wysiwyg' | 'source') => void;
  initializeEditorMode: () => void; // Issue #12: initialise le mode depuis settings
  setMonacoEditor: (editor: editor.IStandaloneCodeEditor | null) => void;

  insertText: (text: string) => void;
  insertCitation: (citationKey: string) => void;
  insertFormatting: (type: 'bold' | 'italic' | 'link' | 'citation' | 'table' | 'footnote' | 'blockquote') => void;
  insertTextAtCursor: (text: string) => void;

  // Direct footnote insertion - returns definition position for scrolling
  insertFootnoteAtPosition: (markdownPosition: number) => { definitionPosition: number; footnoteNumber: number } | null;
  clearPendingFootnoteScroll: () => void;
}

// MARK: - Default settings

const DEFAULT_SETTINGS: EditorSettings = {
  fontSize: 14,
  theme: 'dark',
  wordWrap: true,
  showPreview: false,
  previewPosition: 'right',
  showMinimap: true,
  fontFamily: 'system',
  autoSave: true,
  autoSaveDelay: 3000, // 3 seconds
  defaultEditorMode: 'wysiwyg', // Issue #12: WYSIWYG par défaut
};

// MARK: - Store

export const useEditorStore = create<EditorState>((set, get) => ({
  content: '',
  filePath: null,
  isDirty: false,
  settings: DEFAULT_SETTINGS,
  showPreview: false,
  editorMode: 'wysiwyg',
  pendingFootnoteScroll: null,
  milkdownEditor: null,
  monacoEditor: null,

  setContent: (content: string) => {
    set({
      content,
      isDirty: true,
    });
  },

  loadFile: async (filePath: string) => {
    logger.store('Editor', 'loadFile called', { filePath });
    try {
      logger.ipc('editor.loadFile', { filePath });
      const result = await window.electron.editor.loadFile(filePath);
      logger.ipc('editor.loadFile response', result);

      if (result.success && result.content !== undefined) {
        set({
          content: result.content,
          filePath,
          isDirty: false,
        });
        logger.store('Editor', 'File loaded successfully', { contentLength: result.content.length });
      } else {
        throw new Error(result.error || 'Failed to load file');
      }
    } catch (error) {
      logger.error('Editor', error);
      throw error;
    }
  },

  saveFile: async () => {
    const { content, filePath } = get();
    logger.store('Editor', 'saveFile called', { filePath, contentLength: content.length });

    if (!filePath) {
      throw new Error('No file path specified. Use saveFileAs instead.');
    }

    try {
      logger.ipc('editor.saveFile', { filePath, contentLength: content.length });
      const result = await window.electron.editor.saveFile(filePath, content);
      logger.ipc('editor.saveFile response', result);

      if (result.success) {
        set({ isDirty: false });
        logger.store('Editor', 'File saved successfully');
      } else {
        throw new Error(result.error || 'Failed to save file');
      }
    } catch (error) {
      logger.error('Editor', error);
      throw error;
    }
  },

  saveFileAs: async (newFilePath: string) => {
    const { content } = get();
    logger.store('Editor', 'saveFileAs called', { newFilePath, contentLength: content.length });

    try {
      logger.ipc('editor.saveFile', { filePath: newFilePath, contentLength: content.length });
      const result = await window.electron.editor.saveFile(newFilePath, content);
      logger.ipc('editor.saveFile response', result);

      if (result.success) {
        set({
          filePath: newFilePath,
          isDirty: false,
        });
        logger.store('Editor', 'File saved successfully as', { newFilePath });
      } else {
        throw new Error(result.error || 'Failed to save file');
      }
    } catch (error) {
      logger.error('Editor', error);
      throw error;
    }
  },

  updateSettings: (newSettings: Partial<EditorSettings>) => {
    set((state) => ({
      settings: {
        ...state.settings,
        ...newSettings,
      },
    }));
  },

  togglePreview: () => {
    set((state) => ({
      showPreview: !state.showPreview,
    }));
  },

  toggleStats: () => {
    // Stats are always visible in the new editor, this is a no-op for compatibility
    logger.store('Editor', 'toggleStats called (no-op)');
  },

  toggleEditorMode: () => {
    set((state) => {
      const newMode = state.editorMode === 'wysiwyg' ? 'source' : 'wysiwyg';
      logger.store('Editor', 'toggleEditorMode', { from: state.editorMode, to: newMode });
      return { editorMode: newMode };
    });
  },

  setEditorMode: (mode: 'wysiwyg' | 'source') => {
    logger.store('Editor', 'setEditorMode', { mode });
    set({ editorMode: mode });
  },

  initializeEditorMode: () => {
    const { settings } = get();
    const mode = settings.defaultEditorMode || 'wysiwyg';
    logger.store('Editor', 'initializeEditorMode', { mode });
    set({ editorMode: mode });
  },

  setMonacoEditor: (editor: editor.IStandaloneCodeEditor | null) => {
    set({ monacoEditor: editor });
  },

  insertText: (text: string) => {
    set((state) => ({
      content: state.content + text,
      isDirty: true,
    }));
  },

  insertCitation: (citationKey: string) => {
    const citationText = `[@${citationKey}]`;
    get().insertText(citationText);
  },

  saveCurrentFile: async () => {
    await get().saveFile();
  },

  createNewFile: () => {
    logger.store('Editor', 'createNewFile called');
    set({
      content: '',
      filePath: null,
      isDirty: false,
    });
  },

  insertFormatting: (type: 'bold' | 'italic' | 'link' | 'citation' | 'table' | 'footnote' | 'blockquote') => {
    logger.store('Editor', 'insertFormatting called', { type });
    const { content } = get();
    const editor = get().milkdownEditor;

    // Footnotes: get cursor position and insert directly
    if (type === 'footnote') {
      if (!editor) {
        logger.error('Editor', 'No editor available for footnote insertion');
        return;
      }

      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { state } = view;
          const { selection } = state;

          // Get the plain text before cursor position
          const textBeforeCursor = state.doc.textBetween(0, selection.from, '\n');
          const plainTextLength = textBeforeCursor.length;

          // Map plain text position to markdown position
          const markdown = content;
          let markdownPos = 0;
          let visibleCount = 0;
          let i = 0;

          while (i < markdown.length && visibleCount < plainTextLength) {
            const char = markdown[i];
            const remaining = markdown.slice(i);

            // Skip headers: # at start of line
            if ((i === 0 || markdown[i - 1] === '\n') && char === '#') {
              while (i < markdown.length && markdown[i] === '#') i++;
              if (markdown[i] === ' ') i++;
              continue;
            }

            // Skip bold/italic markers: ** or * or __ or _
            if ((char === '*' || char === '_') && remaining.length > 1) {
              if (remaining[1] === char) {
                i += 2;
                continue;
              } else {
                i++;
                continue;
              }
            }

            // Skip link URLs: [text](url) - skip the url part
            if (char === ']' && remaining.length > 1 && remaining[1] === '(') {
              i += 2;
              while (i < markdown.length && markdown[i] !== ')') i++;
              if (i < markdown.length) i++;
              continue;
            }

            // Skip code blocks: ```...```
            if (char === '`' && remaining.startsWith('```')) {
              i += 3;
              const closeIdx = markdown.indexOf('```', i);
              if (closeIdx !== -1) {
                i = closeIdx + 3;
              }
              continue;
            }

            // Skip inline code markers: `
            if (char === '`') {
              i++;
              continue;
            }

            // Handle newlines: markdown uses \n\n for paragraph breaks
            // but ProseMirror's textBetween uses single \n
            // So we count consecutive newlines as a single visible newline
            if (char === '\n') {
              visibleCount++;
              i++;
              // Skip any additional consecutive newlines
              while (i < markdown.length && markdown[i] === '\n') {
                i++;
              }
              markdownPos = i;
              continue;
            }

            // Regular character - count it
            visibleCount++;
            i++;
            markdownPos = i;
          }

          logger.store('Editor', 'Footnote insertion', {
            cursorPos: selection.from,
            plainTextLength,
            markdownPos,
          });

          // Insert footnote at this position
          get().insertFootnoteAtPosition(markdownPos);
        });
      } catch (error) {
        logger.error('Editor', 'Failed to insert footnote');
      }
      return;
    }

    // Regular formatting
    let textToInsert = '';
    switch (type) {
      case 'bold':
        textToInsert = '**texte en gras**';
        break;
      case 'italic':
        textToInsert = '_texte en italique_';
        break;
      case 'link':
        textToInsert = '[texte du lien](url)';
        break;
      case 'citation':
        textToInsert = '[@clé_citation]';
        break;
      case 'table':
        textToInsert = '\n| Colonne 1 | Colonne 2 |\n|-----------|----------|\n| Cellule 1 | Cellule 2 |\n';
        break;
      case 'blockquote':
        textToInsert = '\n> Citation ou bloc de texte important\n> Continuation de la citation\n';
        break;
    }

    // Try to insert at cursor position using Milkdown editor
    if (editor) {
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { state } = view;
          const { tr, selection } = state;
          tr.insertText(textToInsert, selection.from, selection.to);
          view.dispatch(tr);
          view.focus();
        });
        set({ isDirty: true });
      } catch (error) {
        // Fallback: append to content
        logger.error('Editor', 'Failed to insert at cursor, appending to content');
        set({
          content: content + textToInsert,
          isDirty: true,
        });
      }
    } else {
      // No Milkdown editor, append to content
      set({
        content: content + textToInsert,
        isDirty: true,
      });
    }
  },

  insertTextAtCursor: (text: string) => {
    logger.store('Editor', 'insertTextAtCursor called', { text });
    const editor = get().milkdownEditor;
    if (editor) {
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { state } = view;
          const { tr, selection } = state;
          tr.insertText(text, selection.from, selection.to);
          view.dispatch(tr);
          view.focus();
        });
        set({ isDirty: true });
      } catch (error) {
        logger.error('Editor', 'Failed to insert text at cursor');
      }
    }
  },

  // Direct footnote insertion - returns definition position for scrolling
  insertFootnoteAtPosition: (markdownPosition: number) => {
    const { content } = get();

    // Calculate the next footnote number
    const footnoteRefs = content.match(/\[\^(\d+)\]/g) || [];
    const numbers = footnoteRefs.map(ref => {
      const match = ref.match(/\[\^(\d+)\]/);
      return match ? parseInt(match[1], 10) : 0;
    });
    const footnoteNumber = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;

    const refText = `[^${footnoteNumber}]`;
    const defText = `[^${footnoteNumber}]: `;

    // Insert reference at the specified position
    const beforeRef = content.slice(0, markdownPosition);
    const afterRef = content.slice(markdownPosition);

    // Check if there are existing footnote definitions at the end
    // and insert the new definition before them
    const defRegex = /\n\n(\[\^\d+\]:[\s\S]*)$/;
    const defMatch = afterRef.match(defRegex);

    let newContent: string;
    let definitionPosition: number;

    if (defMatch) {
      // There are existing definitions - insert new def after them (at the end)
      const afterRefWithoutDefs = afterRef.slice(0, defMatch.index);
      const existingDefs = defMatch[1].trimEnd();
      newContent = beforeRef + refText + afterRefWithoutDefs + '\n\n' + existingDefs + '\n\n' + defText;
      // Definition position is at the very end, after the defText marker
      definitionPosition = newContent.length;
    } else {
      // No existing definitions - add at the end
      const trimmedAfter = afterRef.trimEnd();
      newContent = beforeRef + refText + trimmedAfter + '\n\n' + defText;
      // Definition position is at the end, after the defText marker
      definitionPosition = beforeRef.length + refText.length + trimmedAfter.length + 2 + defText.length;
    }

    logger.store('Editor', 'Footnote inserted at position', {
      number: footnoteNumber,
      position: markdownPosition,
      definitionPosition,
    });

    set({
      content: newContent,
      isDirty: true,
      pendingFootnoteScroll: definitionPosition,
    });

    return { definitionPosition, footnoteNumber };
  },

  clearPendingFootnoteScroll: () => {
    set({ pendingFootnoteScroll: null });
  },
}));
