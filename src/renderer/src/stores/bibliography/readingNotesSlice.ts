import type { BibliographySliceCreator, ReadingNotesSliceState } from './types';
import { readingNoteOf } from './referenceTags';

/** Préférence d'affichage, par poste : un gros utilisateur des tags automatiques ne doit pas les réactiver à chaque lancement. */
const SHOW_AUTOMATIC_KEY = 'cliodeck.bibliography.showAutomaticZoteroTags';

/**
 * Libellé d'auteur pour le titre d'une note : le premier nom, puis
 * « et al. » — la liste BibTeX entière (« A and B and C ») n'a rien à faire
 * dans un titre.
 */
function authorLabel(author: string | undefined, editor: string | undefined): string | undefined {
  const names = (author || editor || '').split(/\s+and\s+/).map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return undefined;
  return names.length > 1 ? `${names[0]} et al.` : names[0];
}

function readShowAutomatic(): boolean {
  try {
    return window.localStorage.getItem(SHOW_AUTOMATIC_KEY) === 'true';
  } catch {
    return false;
  }
}

export const createReadingNotesSlice: BibliographySliceCreator<ReadingNotesSliceState> = (set, get) => ({
  readingNotes: [],
  showAutomaticZoteroTags: readShowAutomatic(),

  loadReadingNotes: async () => {
    try {
      const result = await window.electron.bibliography.readingNotes.list();
      set({ readingNotes: result.success && result.notes ? result.notes : [] });
      get().applyFilters();
    } catch (error) {
      console.error('Failed to load reading notes:', error);
    }
  },

  setProjectTags: async (citationId: string, tags: string[]) => {
    const citation = get().citations.find((c) => c.id === citationId);
    if (!citation) return;
    const result = await window.electron.bibliography.readingNotes.setTags({
      citekey: citation.id,
      zoteroKey: citation.zoteroKey,
      title: citation.title,
      author: authorLabel(citation.author, citation.editor),
      year: citation.year || undefined,
      tags,
    });
    if (!result.success || !result.note) {
      throw new Error(result.error ?? 'set_tags_failed');
    }
    const note = result.note;
    set((state) => {
      const others = state.readingNotes.filter((n) => n !== readingNoteOf(citation, state.readingNotes));
      return { readingNotes: [...others, note] };
    });
    get().applyFilters();
  },

  openReadingNote: async (citationId: string) => {
    const citation = get().citations.find((c) => c.id === citationId);
    if (!citation) return null;
    const result = await window.electron.bibliography.readingNotes.open({
      citekey: citation.id,
      zoteroKey: citation.zoteroKey,
      title: citation.title,
      author: authorLabel(citation.author, citation.editor),
      year: citation.year || undefined,
    });
    if (!result.success || !result.file) {
      throw new Error(result.error ?? 'open_failed');
    }
    // La note existe désormais : la liste doit le savoir.
    await get().loadReadingNotes();
    return result.file;
  },

  setShowAutomaticZoteroTags: (show: boolean) => {
    try {
      window.localStorage.setItem(SHOW_AUTOMATIC_KEY, String(show));
    } catch {
      // Stockage indisponible : la préférence vaut pour la session.
    }
    set({ showAutomaticZoteroTags: show });
    get().applyFilters();
  },
});
