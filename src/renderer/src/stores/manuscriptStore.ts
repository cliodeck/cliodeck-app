import { create } from 'zustand';
import type { ResolvedChapter } from '@backend/types/book';
import { computeDocumentStats, type DocumentStatsCounts } from '@/editor/document-stats';
import { parseOutline, type OutlineHeading } from '@/editor/outline';
import { useEditorStore } from './editorStore';
import { useProjectStore } from './projectStore';
import { logger } from '../utils/logger';

/**
 * Vue d'ensemble du manuscrit (plan chapitres, Phase 3).
 *
 * Les fonctions transverses — plan, statistiques d'ouvrage, renumérotation,
 * vérification des citations — ont besoin du texte de chapitres qui ne sont
 * pas ouverts. Ce store garde le DÉRIVÉ (statistiques et plan) de chaque
 * chapitre plutôt que son texte : c'est ce qui permet d'afficher un total
 * d'ouvrage sans re-parser le manuscrit à chaque frappe (mesure du bilan :
 * 165 ms à 400 000 mots).
 *
 * Deux règles :
 * - **le chapitre ouvert n'est jamais lu sur le disque** : son texte vient
 *   de l'éditeur vivant (`getLiveContent`), sinon les frappes non
 *   sauvegardées seraient ignorées ;
 * - le cache est rafraîchi sur des événements rares (liste de chapitres
 *   modifiée, changement de chapitre), jamais à la frappe.
 */

export interface ChapterInfo {
  stats: DocumentStatsCounts;
  outline: OutlineHeading[];
}

export interface ManuscriptDocument {
  chapter: ResolvedChapter;
  content: string;
  /** Le texte vient de l'éditeur (chapitre ouvert) et non du disque. */
  live: boolean;
}

interface ManuscriptState {
  /** Dérivé par chemin de chapitre (relatif au projet). */
  info: Record<string, ChapterInfo>;
  refreshing: boolean;
  /**
   * Une renumérotation des notes écrit les chapitres UN PAR UN sur le
   * disque : un export lancé pendant la boucle assemblerait un manuscrit
   * mi-renuméroté (#30). Les modales d'export refusent de partir tant que
   * ce verrou est posé ; le bouton de renumérotation se désactive aussi.
   */
  renumbering: boolean;
  setRenumbering: (renumbering: boolean) => void;
  /** Recalcule le dérivé de tous les chapitres du manifeste. */
  refreshAll: () => Promise<void>;
  /** Recalcule le dérivé d'un seul chapitre à partir d'un texte connu. */
  refreshOne: (relPath: string, content: string) => void;
  /** Texte ordonné du manuscrit ; le chapitre ouvert vient de l'éditeur. */
  readManuscript: () => Promise<ManuscriptDocument[]>;
  clear: () => void;
}

/** Chemin relatif au projet du fichier actuellement ouvert, si c'en est un. */
export function currentRelativePath(): string | null {
  const { currentProject } = useProjectStore.getState();
  const { filePath } = useEditorStore.getState();
  if (!currentProject || !filePath) return null;
  const prefix = `${currentProject.path}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : null;
}

function derive(content: string): ChapterInfo {
  return { stats: computeDocumentStats(content), outline: parseOutline(content) };
}

export const useManuscriptStore = create<ManuscriptState>((set) => ({
  info: {},
  refreshing: false,
  renumbering: false,
  setRenumbering: (renumbering: boolean) => set({ renumbering }),

  refreshAll: async () => {
    const { currentProject, chapters } = useProjectStore.getState();
    if (!currentProject || chapters.length === 0) {
      set({ info: {} });
      return;
    }

    set({ refreshing: true });
    try {
      const openRel = currentRelativePath();
      const toRead = chapters
        .filter((c) => !c.missing && c.filePath !== openRel)
        .map((c) => c.filePath);

      const info: Record<string, ChapterInfo> = {};

      if (toRead.length > 0) {
        const result = await window.electron.project.readChapters({
          projectPath: currentProject.path,
          filePaths: toRead,
        });
        if (result.success) {
          for (const file of result.files) {
            if (typeof file.content === 'string') {
              info[file.filePath] = derive(file.content);
            }
          }
        }
      }

      // Le chapitre ouvert : toujours l'éditeur vivant.
      if (openRel) {
        info[openRel] = derive(useEditorStore.getState().getLiveContent());
      }

      set({ info });
    } catch (error) {
      logger.error('Manuscript', error);
    } finally {
      set({ refreshing: false });
    }
  },

  refreshOne: (relPath: string, content: string) => {
    set((state) => ({ info: { ...state.info, [relPath]: derive(content) } }));
  },

  readManuscript: async () => {
    const { currentProject, chapters } = useProjectStore.getState();
    if (!currentProject) return [];

    const openRel = currentRelativePath();
    const usable = chapters.filter((c) => !c.missing);
    const toRead = usable.filter((c) => c.filePath !== openRel).map((c) => c.filePath);

    const contents = new Map<string, string>();
    if (toRead.length > 0) {
      const result = await window.electron.project.readChapters({
        projectPath: currentProject.path,
        filePaths: toRead,
      });
      if (!result.success) {
        throw new Error(result.error || 'Failed to read chapters');
      }
      for (const file of result.files) {
        if (typeof file.content === 'string') contents.set(file.filePath, file.content);
      }
    }

    const docs: ManuscriptDocument[] = [];
    for (const chapter of usable) {
      if (chapter.filePath === openRel) {
        docs.push({
          chapter,
          content: useEditorStore.getState().getLiveContent(),
          live: true,
        });
        continue;
      }
      const content = contents.get(chapter.filePath);
      if (content !== undefined) docs.push({ chapter, content, live: false });
    }
    return docs;
  },

  clear: () => set({ info: {}, refreshing: false }),
}));
