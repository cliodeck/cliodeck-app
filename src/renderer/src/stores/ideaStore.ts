/**
 * Idea store — persistent notes/ideas for Brainstorm mode (A11).
 *
 * Each idea is a first-class entity with title, rich content, tags,
 * typed links (to other ideas or bibliography citations), spatial position
 * (for the canvas/board view), and origin tracking.
 *
 * Persisted project-level in `.cliodeck/ideas.json`.
 *
 * Ce fichier n'a qu'un écrivain, ce store, et chaque sauvegarde le réécrit en entier : une
 * liste vide prise pour la vraie l'efface. D'où trois règles. Un fichier qui ne se lit pas
 * n'est jamais une liste vide : abîmé, il est mis de côté (décision de l'auteur, Q5) ;
 * inaccessible, plus rien ne s'écrit. Seule la liste chargée pour un projet s'écrit dans ce
 * projet, et le verrou du main n'y peut rien : il sérialise des écritures, pas leur contenu.
 * Enfin chargements et sauvegardes passent un par un dans une file, et chaque sauvegarde
 * écrit l'état du moment où vient son tour.
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

/** Ce que vaut le fichier du projet chargé : `blocked` n'écrit plus rien. */
export type IdeaPersistence =
  | { kind: 'ready' }
  | { kind: 'quarantined'; backupPath: string }
  | { kind: 'blocked'; reason: string };

interface IdeaState {
  ideas: Idea[];
  isLoading: boolean;
  selectedId: string | null;
  persistence: IdeaPersistence;
  /** Le projet dont `ideas` est la liste : la seule destination possible d'une sauvegarde. */
  loadedFor: string | null;
  saveError: string | null;

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
  /**
   * Écrit ce que le disque n'a pas encore, et attend que ce soit fait. Pour ce qui détruit le
   * panneau ou change de projet : seul le blur d'un champ sauvegarde, et ni `Cmd+Q` ni la croix
   * n'en font un (mesuré dans l'app réelle : la frappe était perdue). Ne rejette jamais.
   */
  flushIdeas: () => Promise<void>;
}

function generateId(): string {
  return `idea_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function ideasFilePath(projectPath: string): string {
  return `${projectPath}/.cliodeck/ideas.json`;
}

function serializeIdeas(ideas: Idea[]): string {
  return JSON.stringify({ ideas }, null, 2);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

function normalizeLink(raw: unknown): IdeaLink[] {
  if (!isRecord(raw) || !isString(raw.targetId)) return [];
  return [{ ...raw, targetId: raw.targetId, targetType: raw.targetType === 'citation' ? 'citation' : 'idea' }];
}

/**
 * Une idée telle que les panneaux la lisent sans précaution : un champ qui manque, après une
 * retouche à la main, ferait tomber le panneau. Ce qui n'est pas un objet n'est pas une idée.
 * Les champs inconnus restent : ils survivent à la sauvegarde.
 */
function normalizeIdea(raw: unknown, seenIds: Set<string>): Idea | null {
  if (!isRecord(raw)) return null;
  const id = isString(raw.id) && raw.id !== '' && !seenIds.has(raw.id) ? raw.id : generateId();
  seenIds.add(id);
  const createdAt = isString(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const { position } = raw;
  return {
    ...raw,
    id,
    title: isString(raw.title) ? raw.title : '',
    content: isString(raw.content) ? raw.content : '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter(isString) : [],
    links: Array.isArray(raw.links) ? raw.links.flatMap(normalizeLink) : [],
    origin: isRecord(raw.origin) && isString(raw.origin.type) ? (raw.origin as unknown as IdeaOrigin) : { type: 'manual' },
    position:
      isRecord(position) && typeof position.x === 'number' && typeof position.y === 'number'
        ? { x: position.x, y: position.y }
        : undefined,
    createdAt,
    updatedAt: isString(raw.updatedAt) ? raw.updatedAt : createdAt,
  } as Idea;
}

/**
 * Le contenu d'`ideas.json`, ou `null` s'il n'y a rien à en tirer. Mettre de côté à tort
 * retirerait des idées saines de l'écran, d'où la tolérance : `{ ideas: [...] }` est le seul
 * format jamais écrit, mais le BOM d'un éditeur externe, un tableau nu ou un champ de plus se
 * chargent, et `{}` vaut une liste vide depuis le premier jour. Un objet qui porte d'autres
 * données n'est pas vide pour autant : le réécrire les perdrait, il se met de côté.
 */
function parseIdeasFile(content: string): Idea[] | null {
  let data: unknown;
  try {
    // `readUserFile` garde le BOM, et `JSON.parse` le refuse.
    data = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  let list: unknown = data;
  if (isRecord(data)) {
    const holdsOtherData = Object.values(data).some((value) => typeof value === 'object' && value !== null);
    list = data.ideas ?? (holdsOtherData ? null : []);
  }
  if (!Array.isArray(list)) return null;

  const seenIds = new Set<string>();
  const ideas: Idea[] = [];
  for (const raw of list) {
    const idea = normalizeIdea(raw, seenIds);
    if (!idea) return null;
    ideas.push(idea);
  }
  return ideas;
}

/** Le temps de laisser finir un autre processus (synchronisation) qui écrit le fichier. */
const QUARANTINE_RECHECK_MS = 500;

type LoadedIdeas =
  | { kind: 'ready'; ideas: Idea[] }
  | { kind: 'quarantined'; backupPath: string }
  | { kind: 'blocked'; reason: string };

/** Lire `ideas.json` à l'instant : `null` pour `ideas` si le contenu est à mettre de côté. */
async function readIdeasOnce(ideasPath: string) {
  const read = await window.electron.fs.readUserFile(ideasPath);
  const ideas = read.kind === 'ok' ? parseIdeasFile(read.content) : null;
  const damaged = (read.kind === 'ok' && !ideas) || (read.kind === 'unreadable' && read.reason === 'encoding');
  return { read, ideas, damaged };
}

/**
 * Ne lève pas. Du contenu abîmé, y compris ce qui n'est pas en UTF-8, se met de côté sans en
 * perdre un octet ; une lecture qui échoue dit seulement qu'on ne sait pas, le fichier est
 * peut-être sain, et rien ne bouge.
 */
async function readIdeasFile(projectPath: string): Promise<LoadedIdeas> {
  const ideasPath = ideasFilePath(projectPath);
  try {
    let attempt = await readIdeasOnce(ideasPath);
    if (attempt.damaged) {
      await new Promise((resolve) => setTimeout(resolve, QUARANTINE_RECHECK_MS));
      attempt = await readIdeasOnce(ideasPath);
    }
    const { read, ideas, damaged } = attempt;
    if (ideas) return { kind: 'ready', ideas };
    if (damaged) {
      const moved = await window.electron.fs.quarantineFile(ideasPath);
      return moved.success
        ? { kind: 'quarantined', backupPath: moved.backupPath }
        : { kind: 'blocked', reason: moved.error };
    }
    if (read.kind === 'unreadable') return { kind: 'blocked', reason: read.message };
    // `absent` vaut aussi pour un disque débranché : la liste vide s'écrirait à son retour, sur
    // les vraies idées. Le dossier du projet, lui, existe toujours.
    if (!(await window.electron.fs.exists(projectPath))) return { kind: 'blocked', reason: projectPath };
    return { kind: 'ready', ideas: [] };
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof Error ? error.message : String(error) };
  }
}

// MARK: - Queue

/** La fin de la file : chaque chargement et chaque sauvegarde attendent ceux d'avant. */
let queueTail: Promise<void> = Promise.resolve();
/** La sauvegarde qui n'a pas encore commencé : elle écrira l'état courant, la suivante s'y joint. */
let waitingSave: { projectPath: string; done: Promise<void> } | null = null;
/** Le dernier chargement demandé : un chargement dépassé ne lit rien. */
let lastLoad = 0;
/** La liste telle que le disque la connaît. */
let writtenIdeas: string | null = null;

function enqueue(job: () => Promise<void>): Promise<void> {
  const done = queueTail.then(job);
  queueTail = done.catch(() => undefined);
  return done;
}

// MARK: - Store

export const useIdeaStore = create<IdeaState>()((set, get) => ({
  ideas: [],
  isLoading: false,
  selectedId: null,
  persistence: { kind: 'ready' },
  loadedFor: null,
  saveError: null,

  loadIdeas: (projectPath: string) => {
    const load = ++lastLoad;
    set({ isLoading: true });
    return enqueue(async () => {
      if (load !== lastLoad) return;
      const before = get();
      const sameProject = before.loadedFor === projectPath;

      // Le panneau se démonte sans blur, et relire ferait disparaître ce qui n'est pas écrit.
      // Si l'écriture échoue, la liste à l'écran reste la seule copie : elle reste à l'écran.
      if (sameProject && hasUnwrittenIdeas() && !(await writeCurrentIdeas(projectPath))) {
        set({ isLoading: load !== lastLoad });
        return;
      }

      const loaded = await readIdeasFile(projectPath);
      const ideas = loaded.kind === 'ready' ? loaded.ideas : [];
      let persistence: IdeaPersistence;
      if (loaded.kind !== 'ready') {
        persistence = loaded;
      } else if (sameProject && before.persistence.kind === 'quarantined') {
        // La mise de côté reste à dire tant que ce projet est ouvert : un rechargement trouve
        // le fichier absent, ou celui que la première sauvegarde vient de créer.
        persistence = before.persistence;
      } else {
        persistence = { kind: 'ready' };
      }
      // Lire n'écrit rien : même normalisée, la liste chargée n'est pas à réécrire.
      writtenIdeas = serializeIdeas(ideas);
      set({ ideas, persistence, loadedFor: projectPath, saveError: null, isLoading: load !== lastLoad });
    });
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

  saveIdeas: (projectPath: string) => {
    if (waitingSave?.projectPath === projectPath) return waitingSave.done;
    const save = {
      projectPath,
      done: enqueue(async () => {
        if (waitingSave === save) waitingSave = null;
        await writeCurrentIdeas(projectPath);
      }),
    };
    waitingSave = save;
    return save.done;
  },

  flushIdeas: () => {
    const { loadedFor, saveIdeas } = get();
    if (loadedFor !== null && hasUnwrittenIdeas()) return saveIdeas(loadedFor);
    // L'auteur a défait ce qui ne s'écrivait pas : plus rien à signaler.
    set({ saveError: null });
    return Promise.resolve();
  },
}));

/**
 * Ce qui est à l'écran et que le disque n'a pas. Rien de tel sans liste chargée, ni quand plus
 * rien ne s'écrit.
 */
export function hasUnwrittenIdeas(): boolean {
  const { ideas, loadedFor, persistence } = useIdeaStore.getState();
  return loadedFor !== null && persistence.kind !== 'blocked' && serializeIdeas(ideas) !== writtenIdeas;
}

/**
 * Le tour d'une sauvegarde : l'état du moment, et seulement dans le projet qui l'a chargé.
 * Sans ce garde, la liste de A partait dans B pendant une bascule, et un clic avant la fin du
 * premier chargement écrasait le fichier par une liste d'une seule idée.
 */
async function writeCurrentIdeas(projectPath: string): Promise<boolean> {
  const { ideas, loadedFor, persistence } = useIdeaStore.getState();
  if (persistence.kind === 'blocked' || loadedFor !== projectPath) {
    console.warn('Ideas not saved:', { projectPath, loadedFor, persistence: persistence.kind });
    return false;
  }
  const data = serializeIdeas(ideas);
  try {
    await window.electron.fs.writeFile(ideasFilePath(projectPath), data);
    writtenIdeas = data;
    useIdeaStore.setState({ saveError: null });
    return true;
  } catch (error) {
    console.error('Failed to save ideas:', error);
    useIdeaStore.setState({ saveError: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
