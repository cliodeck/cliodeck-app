import { create } from 'zustand';

// MARK: - Types

export interface Project {
  id: string;
  name: string;
  path: string;
  type: 'article' | 'book' | 'presentation';
  createdAt: Date;
  lastOpenedAt: Date;
}

export interface Chapter {
  id: string;
  title: string;
  filePath: string;
  order: number;
}

interface ProjectState {
  // Current project
  currentProject: Project | null;
  chapters: Chapter[];
  currentChapterId: string | null;

  // Loading state
  isLoading: boolean;

  // Recent projects
  recentProjects: Project[];

  // Actions
  loadProject: (projectPath: string) => Promise<void>;
  createProject: (name: string, type: Project['type'], path: string) => Promise<void>;
  closeProject: () => void;

  setCurrentChapter: (chapterId: string) => void;
  addChapter: (title: string, filePath: string) => void;
  deleteChapter: (chapterId: string) => void;
  reorderChapters: (chapters: Chapter[]) => void;

  loadRecentProjects: () => Promise<void>;
}

// MARK: - Store

export const useProjectStore = create<ProjectState>((set, get) => ({
  currentProject: null,
  chapters: [],
  currentChapterId: null,
  isLoading: false,
  recentProjects: [],

  loadProject: async (projectPath: string) => {
    set({ isLoading: true });
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

      // Load chapters for book projects
      if (project.type === 'book') {
        const chaptersResult = await window.electron.project.getChapters(project.id);
        if (chaptersResult.success) {
          set({ chapters: chaptersResult.chapters });
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

      // Load document.md into editor
      try {
        const { useEditorStore } = await import('./editorStore');

        // Construct path to document.md (or slides.md for presentations)
        const documentPath = project.type === 'presentation'
          ? `${project.path}/slides.md`
          : `${project.path}/document.md`;

        // Use loadFile instead of setContent to track file path
        await useEditorStore.getState().loadFile(documentPath);
        console.log('📝 Document loaded into editor with path tracking');
      } catch (error) {
        console.error('Failed to load document into editor:', error);

        // If document doesn't exist, create it
        try {
          const { useEditorStore } = await import('./editorStore');
          const documentPath = project.type === 'presentation'
            ? `${project.path}/slides.md`
            : `${project.path}/document.md`;
          await window.electron.fs.writeFile(documentPath, `# ${project.name}\n`);
          await useEditorStore.getState().loadFile(documentPath);
          console.log('📝 Created and loaded document');
        } catch (createError) {
          console.error('Failed to create document:', createError);
        }
      }

      // Update recent projects
      await get().loadRecentProjects();
    } catch (error) {
      console.error('Failed to load project:', error);
      throw error;
    } finally {
      set({ isLoading: false });
    }
  },

  createProject: async (name: string, type: Project['type'], path: string) => {
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
        currentChapterId: null,
      });

      await get().loadRecentProjects();
    } catch (error) {
      console.error('Failed to create project:', error);
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
      currentChapterId: null,
    });
  },

  setCurrentChapter: (chapterId: string) => {
    set({ currentChapterId: chapterId });
  },

  addChapter: (title: string, filePath: string) => {
    const { chapters } = get();
    const newChapter: Chapter = {
      id: crypto.randomUUID(),
      title,
      filePath,
      order: chapters.length,
    };
    set({ chapters: [...chapters, newChapter] });
  },

  deleteChapter: (chapterId: string) => {
    const { chapters } = get();
    set({
      chapters: chapters.filter((c) => c.id !== chapterId),
      currentChapterId: null,
    });
  },

  reorderChapters: (newChapters: Chapter[]) => {
    set({ chapters: newChapters });
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
