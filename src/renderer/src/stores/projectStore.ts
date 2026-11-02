import { create, type StoreApi } from 'zustand';
import {
  DEFAULT_BOOK_SETTINGS,
  type BookSettings,
  type Chapter,
  type ResolvedChapter,
  type UnattachedFile,
} from '@backend/types/book';
import i18n from '../i18n';
import { useDialogStore } from './dialogStore';

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
  /**
   * Rend faux si rien n'a été créé sans qu'il y ait d'erreur : l'auteur garde son
   * tampon sans titre, le verrou est posé, ou une autre demande a pris le pas.
   */
  createProject: (name: string, type: Project['type'], path: string) => Promise<boolean>;
  closeProject: () => void;
  /** Met à jour le projet courant sans le recharger : ni l'éditeur ni les services. */
  patchCurrentProject: (patch: Partial<Pick<Project, 'cslPath'>>) => void;

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

// MARK: - Helpers

/**
 * Sauvegarde le document ouvert dans l'éditeur s'il a des modifications non
 * écrites, en lisant comme la porte le texte vivant : `isDirty` ne voit ni une
 * frappe que la synchronisation n'a pas poussée, ni une frappe pendant une écriture.
 * Appelé avant la fermeture d'un projet, tant que le main autorise encore son
 * écriture. Import dynamique pour éviter le cycle projectStore ↔ editorStore.
 */
async function saveOutgoingEditorIfDirty(): Promise<void> {
  const { writeOpenDocumentWhileDirty } = await import('./editorStore');
  await writeOpenDocumentWhileDirty();
}

/** Le document quitté, à rouvrir si le changement de projet échoue. */
interface DetachedEditor {
  from: string | null;
}

/**
 * Coupe l'éditeur du projet qu'on quitte, AVANT de demander le changement au main.
 * Le sortant s'écrit pendant que son projet est encore le projet courant, et plus
 * rien ne s'y tape ensuite : une frappe pendant `project:load` n'avait plus nulle
 * part où s'écrire, la bascule rejetait, et le repli réécrivait le document entrant.
 *
 * Rend `null` si le changement n'a pas lieu : l'auteur garde son tampon sans titre,
 * une autre demande a pris le pas, ou le verrou est posé, ce qui lui est dit. Rejette
 * si le sortant ne peut pas être écrit : rien n'a changé, et rien ne se perd.
 */
async function detachOutgoingEditor(): Promise<DetachedEditor | null> {
  const { useEditorStore } = await import('./editorStore');
  const outcome = await useEditorStore.getState().replaceBuffer({ kind: 'detach' }, 'project-switch');
  if (outcome.status === 'locked') await useDialogStore.getState().showAlert(i18n.t(outcome.lock));
  return outcome.status === 'replaced' ? { from: outcome.detachedFrom ?? null } : null;
}

/**
 * Le changement de projet a échoué : l'écran montre encore le projet d'avant, et
 * l'éditeur y revient. Si le main a déjà basculé, il refuse de relire ce document :
 * un tampon vide, mais le sortant est sur le disque et l'éditeur n'est pas figé.
 */
async function reopenAfterFailedSwitch(detached: DetachedEditor): Promise<void> {
  const { useEditorStore } = await import('./editorStore');
  const { replaceBuffer } = useEditorStore.getState();
  if (detached.from) {
    try {
      const outcome = await replaceBuffer({ kind: 'open', filePath: detached.from }, 'project-restore');
      if (outcome.status === 'replaced') return;
    } catch (error) {
      console.error('Document sortant impossible à rouvrir:', error);
    }
  }
  await replaceBuffer({ kind: 'untitled' }, 'project-restore');
}

/** Un projet tel que le main le rend : dates sérialisées, et ce qu'il reste à ouvrir. */
interface ProjectFromMain extends Omit<Project, 'createdAt' | 'lastOpenedAt'> {
  createdAt: string;
  lastOpenedAt?: string;
  bibliographySource?: { filePath?: string };
  book?: Partial<BookSettings>;
}

/**
 * Pose le projet entrant, puis ses chapitres, sa bibliographie et son document.
 * Commun à l'ouverture et à la création : la création s'arrêtait au premier point,
 * et l'auteur tapait dans un éditeur sans document ou dans celui du projet d'avant.
 * L'éditeur est détaché quand elle arrive, et n'en sort qu'ici.
 */
async function openProjectContents(
  project: ProjectFromMain,
  set: StoreApi<ProjectState>['setState']
): Promise<void> {
  set({
    currentProject: {
      ...project,
      createdAt: new Date(project.createdAt),
      lastOpenedAt: new Date(project.lastOpenedAt || project.createdAt),
    },
    // Rien du projet d'avant : un navigateur composerait ses chemins sous le nouveau.
    chapters: [],
    unattachedFiles: [],
    currentChapterId: null,
    bookSettings: { ...DEFAULT_BOOK_SETTINGS },
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

  const { useEditorStore } = await import('./editorStore');
  const { replaceBuffer } = useEditorStore.getState();
  const openDocument = async (filePath: string): Promise<boolean> => {
    const outcome = await replaceBuffer({ kind: 'open', filePath }, 'project-open');
    return outcome.status === 'replaced';
  };

  let opened = false;
  if (!documentPath) {
    // Livre au manifeste vide (tous les chapitres manquants, ou projet
    // créé hors app) : on n'invente pas de fichier — la Phase 2 offrira
    // de créer un chapitre ou de rattacher un fichier existant.
    console.warn('ℹ️ Aucun chapitre à ouvrir : manifeste vide');
  } else {
    try {
      // Load file FIRST so content is ready in the store
      opened = await openDocument(documentPath);
      console.log('📝 Document loaded into editor with path tracking');
    } catch (error) {
      console.error('Failed to load document into editor:', error);

      // If document doesn't exist, create it
      try {
        await window.electron.fs.writeFile(documentPath, `# ${project.name}\n`);
        opened = await openDocument(documentPath);
        console.log('📝 Created and loaded document');
      } catch (createError) {
        console.error('Failed to create document:', createError);
      }
    }
  }

  // Rien à ouvrir : ni l'ancien document, ni un éditeur figé en lecture seule.
  if (!opened) await replaceBuffer({ kind: 'untitled' }, 'project-open');
}

/**
 * Le verrou de bascule de l'éditeur vaut aussi pour le projet : une
 * renumérotation écrit le manuscrit du projet courant, fichier par fichier.
 * Rend vrai si l'action doit s'arrêter, l'auteur étant alors prévenu. Une
 * alerte et non un rejet : les appelants traduiraient un rejet par « project.json
 * endommagé », et le bouton de fermeture n'en attrape aucun.
 */
async function refusedBySwitchLock(): Promise<boolean> {
  const { useEditorStore } = await import('./editorStore');
  const { switchLock } = useEditorStore.getState();
  if (!switchLock) return false;
  await useDialogStore.getState().showAlert(i18n.t(switchLock));
  return true;
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
    if (await refusedBySwitchLock()) return;
    const loadStateBefore = get().loadState;
    set({ loadState: { kind: 'loading', path: projectPath } });
    let detached: DetachedEditor | null = null;
    try {
      detached = await detachOutgoingEditor();
      if (!detached) {
        set({ loadState: loadStateBefore });
        return;
      }

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

      await openProjectContents(project, set);

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
      if (detached) await reopenAfterFailedSwitch(detached);
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
    if (await refusedBySwitchLock()) return false;
    const loadStateBefore = get().loadState;
    set({ loadState: { kind: 'loading', path } });
    let detached: DetachedEditor | null = null;
    try {
      // Même coupure que loadProject : créer un projet bascule aussi le main.
      detached = await detachOutgoingEditor();
      if (!detached) {
        set({ loadState: loadStateBefore });
        return false;
      }

      const result = await window.electron.project.create({ name, type, path });

      if (!result.success || !result.project) {
        throw new Error(result.error || 'Failed to create project');
      }

      await openProjectContents(result.project, set);

      await get().loadRecentProjects();

      set({
        loadState: {
          kind: 'ready',
          loadedAt: new Date().toISOString(),
          path,
        },
      });
      return true;
    } catch (error) {
      console.error('Failed to create project:', error);
      if (detached) await reopenAfterFailedSwitch(detached);
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
    if (await refusedBySwitchLock()) return;

    // Fermer le projet abandonne le document courant : on le sauvegarde
    // tant que le backend du projet est encore ouvert. Best-effort ici (la
    // fermeture doit rester possible), mais l'échec est signalé.
    try {
      await saveOutgoingEditorIfDirty();
    } catch (error) {
      console.error('❌ Sauvegarde du document sortant impossible à la fermeture:', error);
    }

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

  patchCurrentProject: (patch) => {
    const { currentProject } = get();
    if (currentProject) set({ currentProject: { ...currentProject, ...patch } });
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
