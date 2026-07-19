import { create } from 'zustand';
import type { EditorFacade } from '@/editor/facade';
import { nextFootnoteNumber } from '@/editor/footnote-tools';
import { logger } from '../utils/logger';
import {
  appendDraftToContent,
  insertDraftAtOffset,
} from '../components/Brainstorm/messageToDraft';

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
}

interface EditorState {
  // Content
  content: string;
  filePath: string | null;
  isDirty: boolean;
  /**
   * Horodatage (ms) de la dernière sauvegarde réussie du fichier courant,
   * `null` tant que rien n'a été écrit. Alimente l'indicateur de la barre
   * d'état : sur un manuscrit long, ne pas savoir si son texte est sur le
   * disque est anxiogène (audit item 20).
   */
  lastSavedAt: number | null;

  // Settings
  settings: EditorSettings;

  // Preview
  showPreview: boolean;

  /**
   * Façade éditeur-agnostique posée par l'éditeur CM6 au montage.
   * Point de contact unique pour les Slides, l'IPC et les insertions.
   */
  editorFacade: EditorFacade | null;

  /**
   * Incrémenté à chaque remplacement externe du document (loadFile,
   * createNewFile) : l'éditeur CM6 se recrée sur ce signal au lieu
   * d'observer `content` (interdit — boucle de resynchronisation).
   */
  documentVersion: number;

  // Actions
  setContent: (content: string) => void;
  loadFile: (filePath: string) => Promise<void>;
  saveFile: () => Promise<void>;
  saveFileAs: (filePath: string) => Promise<void>;
  saveCurrentFile: () => Promise<void>;
  createNewFile: () => void;

  updateSettings: (settings: Partial<EditorSettings>) => void;
  togglePreview: () => void;
  setEditorFacade: (facade: EditorFacade | null) => void;
  /** Contenu réel : l'éditeur vivant s'il est monté, sinon le miroir du store. */
  getLiveContent: () => string;

  insertText: (text: string) => void;
  insertCitation: (citationKey: string) => void;
  insertFormatting: (type: 'bold' | 'italic' | 'link' | 'citation' | 'table' | 'footnote' | 'blockquote') => void;
  insertTextAtCursor: (text: string) => void;

  /**
   * Splice a multi-line draft into the document at the user's current
   * cursor (fusion 2.6, A13 option a). When no editor is mounted the call
   * falls back to appending. Returns the mode actually used so the caller
   * can adapt the UX confirmation ("inserted at cursor" vs "appended").
   */
  insertDraftAtCursor: (
    draft: string,
    source?: { model?: string; task?: string }
  ) => { mode: 'cursor' | 'append' };

  // Direct footnote insertion - returns definition position for scrolling
  insertFootnoteAtPosition: (markdownPosition: number) => { definitionPosition: number; footnoteNumber: number } | null;
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
};

// MARK: - Store

export const useEditorStore = create<EditorState>((set, get) => ({
  content: '',
  filePath: null,
  isDirty: false,
  lastSavedAt: null,
  settings: DEFAULT_SETTINGS,
  showPreview: false,
  editorFacade: null,
  documentVersion: 0,

  setContent: (content: string) => {
    set({
      content,
      isDirty: true,
    });
  },

  loadFile: async (filePath: string) => {
    logger.store('Editor', 'loadFile called', { filePath });

    // Bascule de fichier : le fichier sortant est sauvegardé AVANT toute
    // chose. Sans cela, les frappes des dernières secondes étaient perdues
    // (useAutoSave annule son minuteur quand `filePath` change) et le
    // contenu sortant finissait écrit dans le fichier entrant. La
    // sauvegarde lit l'éditeur vivant (`getLiveContent`), donc y compris
    // ce que la synchronisation debouncée n'a pas encore poussé.
    const previousPath = get().filePath;
    if (previousPath && previousPath !== filePath && get().isDirty) {
      try {
        await get().saveFile();
        logger.store('Editor', 'Outgoing file saved before switch', { previousPath });
      } catch (error) {
        // Échec de sauvegarde : on n'ouvre pas le fichier suivant, sinon
        // les modifications non écrites seraient perdues sans un mot.
        logger.error('Editor', error);
        throw error;
      }
    }

    try {
      logger.ipc('editor.loadFile', { filePath });
      const result = await window.electron.editor.loadFile(filePath);
      logger.ipc('editor.loadFile response', result);

      if (result.success && result.content !== undefined) {
        set((state) => ({
          content: result.content,
          filePath,
          isDirty: false,
          // Nouveau document : l'indicateur ne doit pas dater d'un autre.
          lastSavedAt: null,
          documentVersion: state.documentVersion + 1,
        }));
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
    // La sauvegarde lit l'éditeur vivant, jamais le miroir du store : la
    // synchronisation CM6 → store est debouncée et peut être en retard.
    const content = get().getLiveContent();
    const { filePath } = get();
    logger.store('Editor', 'saveFile called', { filePath, contentLength: content.length });

    if (!filePath) {
      throw new Error('No file path specified. Use saveFileAs instead.');
    }

    try {
      logger.ipc('editor.saveFile', { filePath, contentLength: content.length });
      const result = await window.electron.editor.saveFile(filePath, content);
      logger.ipc('editor.saveFile response', result);

      if (result.success) {
        set({ content, isDirty: false, lastSavedAt: Date.now() });
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
    const content = get().getLiveContent();
    logger.store('Editor', 'saveFileAs called', { newFilePath, contentLength: content.length });

    try {
      logger.ipc('editor.saveFile', { filePath: newFilePath, contentLength: content.length });
      const result = await window.electron.editor.saveFile(newFilePath, content);
      logger.ipc('editor.saveFile response', result);

      if (result.success) {
        set({
          content,
          filePath: newFilePath,
          isDirty: false,
          lastSavedAt: Date.now(),
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

  setEditorFacade: (facade: EditorFacade | null) => {
    set({ editorFacade: facade });
  },

  getLiveContent: () => {
    const { editorFacade, content } = get();
    return editorFacade ? editorFacade.getValue() : content;
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
    get().editorFacade?.setValue('');
    set((state) => ({
      content: '',
      filePath: null,
      isDirty: false,
      lastSavedAt: null,
      documentVersion: state.documentVersion + 1,
    }));
  },

  insertFormatting: (type: 'bold' | 'italic' | 'link' | 'citation' | 'table' | 'footnote' | 'blockquote') => {
    logger.store('Editor', 'insertFormatting called', { type });
    const { content, editorFacade } = get();

    // Footnote : offset exact du curseur via la façade.
    if (type === 'footnote') {
      if (editorFacade) {
        get().insertFootnoteAtPosition(editorFacade.getCursorOffset());
      } else {
        logger.error('Editor', 'No editor available for footnote insertion');
      }
      return;
    }

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

    if (editorFacade) {
      editorFacade.replaceSelection(textToInsert);
      set({ isDirty: true });
      return;
    }

    // Aucun éditeur monté : append au contenu.
    set({
      content: content + textToInsert,
      isDirty: true,
    });
  },

  insertTextAtCursor: (text: string) => {
    logger.store('Editor', 'insertTextAtCursor called', { text });
    const { editorFacade } = get();
    if (editorFacade) {
      editorFacade.replaceSelection(text);
      set({ isDirty: true });
    }
  },

  insertDraftAtCursor: (
    draft: string,
    source?: { model?: string; task?: string }
  ): { mode: 'cursor' | 'append' } => {
    const { content, editorFacade } = get();

    // Le draft IA passe par le CONTRAT PROPOSITIONNEL (Phase 4b) —
    // proposition d'insertion adjudicable au curseur, jamais d'écriture
    // directe (« aucune fonctionnalité IA d'écriture ne contourne cette
    // API », docs/editor-proposals.md). Le document ne change qu'à
    // l'acceptation.
    if (editorFacade?.propose) {
      const current = editorFacade.getValue();
      const offset = editorFacade.getCursorOffset();
      const newContent = insertDraftAtOffset(current, offset, draft);
      // Segment exactement inséré par insertDraftAtOffset (padding de bloc
      // compris) : premier point de divergence des deux chaînes.
      let at = 0;
      while (at < current.length && current[at] === newContent[at]) at += 1;
      const inserted = newContent.slice(
        at,
        at + (newContent.length - current.length)
      );
      editorFacade.propose({
        range: { from: at, to: at },
        original: '',
        proposed: inserted,
        category: 'brainstorm-draft',
        // L'appelant (AssistantChat) transmet le modèle actif quand il le
        // connaît — le store éditeur ne se couple pas au store chat.
        source: {
          model: source?.model ?? 'unknown',
          task: source?.task ?? 'brainstorm',
        },
      });
      editorFacade.focus();
      return { mode: 'cursor' };
    }

    // Façade sans support des propositions (défensif) — insertion directe.
    if (editorFacade) {
      const current = editorFacade.getValue();
      const offset = editorFacade.getCursorOffset();
      const newContent = insertDraftAtOffset(current, offset, draft);
      editorFacade.setValue(newContent, offset + (newContent.length - current.length));
      editorFacade.focus();
      set({ content: newContent, isDirty: true });
      return { mode: 'cursor' };
    }

    // No editor mounted — fall back to append.
    set({
      content: appendDraftToContent(content, draft),
      isDirty: true,
    });
    return { mode: 'append' };
  },

  // Direct footnote insertion - returns definition position for scrolling
  insertFootnoteAtPosition: (markdownPosition: number) => {
    const content = get().getLiveContent();

    // Prochain numéro par parse Lezer : un `[^99]` dans un bloc de code
    // n'est pas une note (l'ancienne regex comptait tout le contenu).
    const footnoteNumber = nextFootnoteNumber(content);

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

    const { editorFacade } = get();
    if (editorFacade) {
      // L'éditeur reçoit l'édition directement, curseur dans la définition.
      editorFacade.setValue(newContent, definitionPosition);
      editorFacade.focus();
      set({ content: newContent, isDirty: true });
    } else {
      set({ content: newContent, isDirty: true });
    }

    return { definitionPosition, footnoteNumber };
  },
}));
