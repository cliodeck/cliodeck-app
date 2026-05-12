/**
 * Idea store — persistent notes/ideas for Brainstorm mode (A11).
 *
 * Each idea is a first-class entity with title, rich content, tags,
 * typed links (to other ideas or bibliography citations), spatial position
 * (for the canvas/board view), and origin tracking.
 *
 * Persisted project-level in `.cliodeck/ideas.json`.
 */

import { create } from 'zustand';

// MARK: - Types

export type IdeaOrigin =
  | { type: 'chat'; sessionId?: string; messageId?: string }
  | { type: 'manual' }
  | { type: 'obsidian'; notePath: string }
  | { type: 'import'; source: string };

export interface IdeaLink {
  targetId: string;
  targetType: 'idea' | 'citation';
  label?: string;
}

export interface IdeaPosition {
  x: number;
  y: number;
}

export interface Idea {
  id: string;
  title: string;
  content: string;
  tags: string[];
  links: IdeaLink[];
  origin: IdeaOrigin;
  position?: IdeaPosition;
  color?: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

interface IdeaState {
  ideas: Idea[];
  isLoading: boolean;
  selectedId: string | null;

  // CRUD
  loadIdeas: (projectPath: string) => Promise<void>;
  addIdea: (idea: Omit<Idea, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateIdea: (id: string, patch: Partial<Omit<Idea, 'id' | 'createdAt'>>) => void;
  removeIdea: (id: string) => void;

  // Linking
  addLink: (fromId: string, link: IdeaLink) => void;
  removeLink: (fromId: string, targetId: string) => void;

  // Tags
  addTag: (id: string, tag: string) => void;
  removeTag: (id: string, tag: string) => void;
  getAllTags: () => string[];

  // Selection
  setSelected: (id: string | null) => void;

  // Persistence
  saveIdeas: (projectPath: string) => Promise<void>;
}

function generateId(): string {
  return `idea_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// MARK: - Store

export const useIdeaStore = create<IdeaState>()((set, get) => ({
  ideas: [],
  isLoading: false,
  selectedId: null,

  loadIdeas: async (projectPath: string) => {
    set({ isLoading: true });
    try {
      const ideasPath = `${projectPath}/.cliodeck/ideas.json`;
      const exists = await window.electron.fs.exists(ideasPath);
      if (exists) {
        const content = await window.electron.fs.readFile(ideasPath);
        const data = JSON.parse(content);
        set({ ideas: data.ideas ?? [], isLoading: false });
      } else {
        set({ ideas: [], isLoading: false });
      }
    } catch (error) {
      console.warn('Could not load ideas:', error);
      set({ ideas: [], isLoading: false });
    }
  },

  addIdea: (ideaData) => {
    const now = new Date().toISOString();
    const id = generateId();
    const idea: Idea = {
      ...ideaData,
      id,
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({ ideas: [...state.ideas, idea] }));
    return id;
  },

  updateIdea: (id, patch) => {
    set((state) => ({
      ideas: state.ideas.map((i) =>
        i.id === id
          ? { ...i, ...patch, updatedAt: new Date().toISOString() }
          : i
      ),
    }));
  },

  removeIdea: (id) => {
    set((state) => ({
      ideas: state.ideas.filter((i) => i.id !== id),
      selectedId: state.selectedId === id ? null : state.selectedId,
    }));
  },

  addLink: (fromId, link) => {
    set((state) => ({
      ideas: state.ideas.map((i) =>
        i.id === fromId
          ? {
              ...i,
              links: [...i.links, link],
              updatedAt: new Date().toISOString(),
            }
          : i
      ),
    }));
  },

  removeLink: (fromId, targetId) => {
    set((state) => ({
      ideas: state.ideas.map((i) =>
        i.id === fromId
          ? {
              ...i,
              links: i.links.filter((l) => l.targetId !== targetId),
              updatedAt: new Date().toISOString(),
            }
          : i
      ),
    }));
  },

  addTag: (id, tag) => {
    set((state) => ({
      ideas: state.ideas.map((i) =>
        i.id === id && !i.tags.includes(tag)
          ? { ...i, tags: [...i.tags, tag], updatedAt: new Date().toISOString() }
          : i
      ),
    }));
  },

  removeTag: (id, tag) => {
    set((state) => ({
      ideas: state.ideas.map((i) =>
        i.id === id
          ? { ...i, tags: i.tags.filter((t) => t !== tag), updatedAt: new Date().toISOString() }
          : i
      ),
    }));
  },

  getAllTags: () => {
    const allTags = new Set<string>();
    for (const idea of get().ideas) {
      for (const tag of idea.tags) allTags.add(tag);
    }
    return [...allTags].sort();
  },

  setSelected: (id) => set({ selectedId: id }),

  saveIdeas: async (projectPath: string) => {
    try {
      const ideasPath = `${projectPath}/.cliodeck/ideas.json`;
      const data = JSON.stringify({ ideas: get().ideas }, null, 2);
      await window.electron.fs.writeFile(ideasPath, data);
    } catch (error) {
      console.error('Failed to save ideas:', error);
    }
  },
}));
