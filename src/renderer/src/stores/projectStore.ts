import { create } from 'zustand';
import {
  DEFAULT_BOOK_SETTINGS,
  type BookSettings,
  type Chapter,
  type ResolvedChapter,
  type UnattachedFile,
} from '@backend/types/book';

// MARK: - Types

export type { Chapter, ResolvedChapter, UnattachedFile, BookSettings };

export interface Project {
  id: string;
  name: string;
  path: string;
  type: 'article' | 'book' | 'presentation';
  createdAt: Date;
  lastOpenedAt: Date;
  cslPath?: string;
  // Resolved absolute path to the bibliography file, derived from
  // `bibliographySource` by `project-manager.ts` at load time. Optional
  // because older / freshly-created projects may not have one yet.
  bibliography?: string;
}

/**
 * Typed load state machine (fusion 3.10, claw-code lesson 6.1).
 *
 * Replaces the legacy `isLoading: boolean`. Components that just want
 * a spinner can read `loadState.kind === 'loading'`; components that
 * need the failure reason (toast, retry button) get it without a side
 * channel. `ready` does NOT carry the project itself — `currentProject`
 * remains the single source of truth for "what is loaded right now"
 * so existing selectors keep working unchanged.
 */
export type ProjectLoadState =
  | { kind: 'idle' }
  | { kind: 'loading'; path: string }
  | { kind: 'ready'; loadedAt: string; path: string }
  | { kind: 'failed'; path: string; error: string; at: string };

interface ProjectState {
  // Current project
  currentProject: Project | null;
  /** Manifeste réconcilié avec le disque (entrées `missing` conservées). */
  chapters: ResolvedChapter[];
  /** Fichiers markdown trouvés hors manifeste — la Phase 2 les rattachera. */
  unattachedFiles: UnattachedFile[];
  currentChapterId: string | null;
  /** Réglages d'appareil savant de l'ouvrage courant. */
  bookSettings: BookSettings;

  // Typed load state — see ProjectLoadState above.
  loadState: ProjectLoadState;

  // Recent projects
  recentProjects: Project[];

  // Actions
  loadProject: (projectPath: string) => Promise<void>;
  createProject: (name: string, type: Project['type'], path: string) => Promise<void>;
  closeProject: () => void;

  setCurrentChapter: (chapterId: string) => void;
  /** Recharge le manifeste depuis le disque (après création/modification). */
  refreshChapters: () => Promise<void>;
  /** Crée le fichier du chapitre ET l'entrée de manifeste. */
  addChapter: (title: string, kind?: Chapter['kind']) => Promise<void>;
  /** Retire du manifeste — le fichier reste sur le disque. */
  deleteChapter: (chapterId: string) => Promise<void>;
  reorderChapters: (chapters: Chapter[]) => Promise<void>;
  updateBookSettings: (settings: Partial<BookSettings>) => Promise<void>;

  loadRecentProjects: () => Promise<void>;
}

// MARK: - Store

export const useProjectStore = create<ProjectState>((set, get) => ({
  currentProject: null,
  chapters: [],
  unattachedFiles: [],
  currentChapterId: null,
  bookSettings: { ...DEFAULT_BOOK_SETTINGS },
  loadState: { kind: 'idle' },
  recentProjects: [],

  loadProject: async (projectPath: string) => {
    set({ loadState: { kind: 'loading', path: projectPath } });
    try {
      // Call IPC to load project
      const result = await window.electron.project.load(projectPath);

      if (!result.success || !result.project) {
        throw new Error(result.error || 'Failed to load project');
      }

      const project = result.project;

      console.log('📥 Raw project data from backend:', {
        project: project,
        bibliography: project.bibliography,
        bibliographySource: project.bibliographySource
      });

      set({
        currentProject: {
          ...project,
          createdAt: new Date(project.createdAt),
          lastOpenedAt: new Date(project.lastOpenedAt || project.createdAt),
        },
      });

      // Chapitres des projets « livre ». Best-effort : un échec ici ne doit
      // JAMAIS empêcher l'ouverture du projet — un manuscrit ne devient pas
      // inaccessible à cause d'une liste accessoire.
      let firstChapterPath: string | null = null;
      if (project.type === 'book') {
        set({ bookSettings: { ...DEFAULT_BOOK_SETTINGS, ...(project.book ?? {}) } });
        try {
          const chaptersResult = await window.electron.project.getChapters(project.path);
          if (chaptersResult.success) {
            set({
              chapters: chaptersResult.chapters,
              unattachedFiles: chaptersResult.unattached ?? [],
            });
            const first = chaptersResult.chapters.find(
              (c: ResolvedChapter) => !c.missing
            );
            if (first) {
              firstChapterPath = `${project.path}/${first.filePath}`;
              set({ currentChapterId: first.id });
            }
          }
        } catch (error) {
          console.warn('⚠️ Chapitres indisponibles (projet ouvert malgré tout):', error);
        }
      }

      // Load bibliography if configured
      console.log('🔍 Project data received:', {
        hasBibliography: !!project.bibliography,
        bibliographyPath: project.bibliography,
        hasBibliographySource: !!project.bibliographySource
      });

      // Try loading from bibliographySource first (new system), fallback to bibliography (old system)
      let bibliographyPath: string | null = null;

      if (project.bibliographySource?.filePath) {
        // New system: construct path from project directory + relative file path
        bibliographyPath = `${project.path}/${project.bibliographySource.filePath}`;
        console.log('📚 Using bibliographySource:', project.bibliographySource);
      } else if (project.bibliography) {
        // Old system: use absolute path directly
        bibliographyPath = project.bibliography;
        console.log('📚 Using legacy bibliography path');
      }

      if (bibliographyPath) {
        try {
          const { useBibliographyStore } = await import('./bibliographyStore');
          console.log('📚 Loading bibliography from:', bibliographyPath);
          // Use loadBibliographyWithMetadata to restore zoteroAttachments from metadata file
          await useBibliographyStore.getState().loadBibliographyWithMetadata(bibliographyPath, project.path);
          console.log('✅ Bibliography loaded for project (with metadata)');
          // Refresh indexed PDFs to update the Chat panel state
          await useBibliographyStore.getState().refreshIndexedPDFs();
          console.log('✅ Indexed PDFs refreshed');
        } catch (error) {
          console.error('❌ Failed to load project bibliography:', error);
        }
      } else {
        console.log('ℹ️ No bibliography to load');
        // Still refresh indexed PDFs in case there are documents indexed without bibliography
        try {
          const { useBibliographyStore } = await import('./bibliographyStore');
          await useBibliographyStore.getState().refreshIndexedPDFs();
        } catch (error) {
          console.error('❌ Failed to refresh indexed PDFs:', error);
        }
      }

      // Ouvrir le document principal. Pour un livre, c'est le PREMIER
      // chapitre du manifeste : un livre n'a pas de `document.md` et
      // l'ouvrir créerait un fichier fantôme hors manuscrit.
      const documentPath =
        project.type === 'presentation'
          ? `${project.path}/slides.md`
          : project.type === 'book'
            ? firstChapterPath
            : `${project.path}/document.md`;

      if (!documentPath) {
        // Livre au manifeste vide (tous les chapitres manquants, ou projet
        // créé hors app) : on n'invente pas de fichier — la Phase 2 offrira
        // de créer un chapitre ou de rattacher un fichier existant.
        console.warn('ℹ️ Aucun chapitre à ouvrir : manifeste vide');
      } else {
        try {
          // Load file FIRST so content is ready in the store
          const { useEditorStore } = await import('./editorStore');
          await useEditorStore.getState().loadFile(documentPath);
          console.log('📝 Document loaded into editor with path tracking');
        } catch (error) {
          console.error('Failed to load document into editor:', error);

          // If document doesn't exist, create it
          try {
            const { useEditorStore } = await import('./editorStore');
            await window.electron.fs.writeFile(documentPath, `# ${project.name}\n`);
            await useEditorStore.getState().loadFile(documentPath);
            console.log('📝 Created and loaded document');
          } catch (createError) {
            console.error('Failed to create document:', createError);
          }
        }
      }

      // Update recent projects
      await get().loadRecentProjects();

      set({
        loadState: {
          kind: 'ready',
          loadedAt: new Date().toISOString(),
          path: projectPath,
        },
      });
    } catch (error) {
      console.error('Failed to load project:', error);
      set({
        loadState: {
          kind: 'failed',
          path: projectPath,
          error: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        },
      });
      throw error;
    }
  },

  createProject: async (name: string, type: Project['type'], path: string) => {
    set({ loadState: { kind: 'loading', path } });
    try {
      const result = await window.electron.project.create({ name, type, path });

      if (!result.success || !result.project) {
        throw new Error(result.error || 'Failed to create project');
      }

      const project = result.project;

      set({
        currentProject: {
          ...project,
          createdAt: new Date(project.createdAt),
          lastOpenedAt: new Date(project.lastOpenedAt || project.createdAt),
        },
        chapters: [],
        unattachedFiles: [],
        currentChapterId: null,
        bookSettings: { ...DEFAULT_BOOK_SETTINGS },
        loadState: {
          kind: 'ready',
          loadedAt: new Date().toISOString(),
          path,
        },
      });

      await get().loadRecentProjects();
    } catch (error) {
      console.error('Failed to create project:', error);
      set({
        loadState: {
          kind: 'failed',
          path,
          error: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        },
      });
      throw error;
    }
  },

  closeProject: async () => {
    try {
      // Close backend resources (PDF Service, vector store, etc.)
      await window.electron.project.close();
      console.log('✅ Backend resources closed');
    } catch (error) {
      console.error('❌ Failed to close backend resources:', error);
    }

    // Clear frontend state
    set({
      currentProject: null,
      chapters: [],
      unattachedFiles: [],
      currentChapterId: null,
      bookSettings: { ...DEFAULT_BOOK_SETTINGS },
      loadState: { kind: 'idle' },
    });
  },

  setCurrentChapter: (chapterId: string) => {
    set({ currentChapterId: chapterId });
  },

  refreshChapters: async () => {
    const { currentProject } = get();
    if (!currentProject || currentProject.type !== 'book') return;
    try {
      const result = await window.electron.project.getChapters(currentProject.path);
      if (result.success) {
        set({
          chapters: result.chapters,
          unattachedFiles: result.unattached ?? [],
        });
      }
    } catch (error) {
      console.warn('⚠️ Rafraîchissement des chapitres impossible:', error);
    }
  },

  addChapter: async (title: string, kind?: Chapter['kind']) => {
    const { currentProject } = get();
    if (!currentProject) throw new Error('Aucun projet ouvert');
    // Le fichier ET l'entrée de manifeste sont créés côté main, en une
    // opération : pas d'entrée sans fichier ni l'inverse.
    const result = await window.electron.project.createChapter({
      projectPath: currentProject.path,
      title,
      kind,
    });
    if (!result.success) {
      throw new Error(result.error || 'Création du chapitre impossible');
    }
    await get().refreshChapters();
  },

  deleteChapter: async (chapterId: string) => {
    const { currentProject, chapters, currentChapterId } = get();
    if (!currentProject) throw new Error('Aucun projet ouvert');
    // Le fichier reste sur le disque (décision cadre : on ne perd jamais de
    // texte) ; il réapparaîtra comme « non rattaché ».
    const remaining = chapters
      .filter((c) => c.id !== chapterId)
      .map(({ missing: _missing, ...chapter }) => chapter);
    const result = await window.electron.project.saveChapters({
      projectPath: currentProject.path,
      chapters: remaining,
    });
    if (!result.success) {
      throw new Error(result.error || 'Suppression du chapitre impossible');
    }
    set({ currentChapterId: currentChapterId === chapterId ? null : currentChapterId });
    await get().refreshChapters();
  },

  reorderChapters: async (newChapters: Chapter[]) => {
    const { currentProject } = get();
    if (!currentProject) throw new Error('Aucun projet ouvert');
    // Optimiste : l'ordre local suit immédiatement le glisser-déposer, le
    // disque confirme ensuite (l'ordre stocké est renormalisé côté main).
    set({ chapters: newChapters.map((c, index) => ({ ...c, order: index })) });
    const result = await window.electron.project.saveChapters({
      projectPath: currentProject.path,
      chapters: newChapters.map(({ ...chapter }) => chapter),
    });
    if (!result.success) {
      await get().refreshChapters(); // rollback depuis la vérité disque
      throw new Error(result.error || 'Réordonnancement impossible');
    }
  },

  updateBookSettings: async (settings: Partial<BookSettings>) => {
    const { currentProject, bookSettings } = get();
    if (!currentProject) throw new Error('Aucun projet ouvert');
    const previous = bookSettings;
    set({ bookSettings: { ...bookSettings, ...settings } });
    const result = await window.electron.project.saveBookSettings({
      projectPath: currentProject.path,
      settings,
    });
    if (!result.success) {
      set({ bookSettings: previous });
      throw new Error(result.error || 'Enregistrement des réglages impossible');
    }
    if (result.settings) set({ bookSettings: result.settings });
  },

  loadRecentProjects: async () => {
    try {
      const recentPaths = await window.electron.project.getRecent();
      const pathsToRemove: string[] = [];

      const recentProjects = await Promise.all(
        recentPaths.map(async (path: string) => {
          try {
            // Use getMetadata instead of load to avoid initializing services for each project
            const result = await window.electron.project.getMetadata(path);
            if (!result.success || !result.project) {
              // Project doesn't exist anymore, mark for removal
              pathsToRemove.push(path);
              return null;
            }
            const project = result.project;
            return {
              ...project,
              createdAt: new Date(project.createdAt),
              lastOpenedAt: new Date(project.lastOpenedAt || project.createdAt),
            };
          } catch {
            // Project doesn't exist anymore, mark for removal
            pathsToRemove.push(path);
            return null;
          }
        })
      );

      // Remove non-existent projects from the recent list
      if (pathsToRemove.length > 0) {
        console.log(`🧹 Removing ${pathsToRemove.length} non-existent project(s) from recent list`);
        for (const path of pathsToRemove) {
          await window.electron.project.removeRecent(path);
        }
      }

      set({
        recentProjects: recentProjects.filter((p): p is Project => p !== null),
      });
    } catch (error) {
      console.error('Failed to load recent projects:', error);
    }
  },
}));
