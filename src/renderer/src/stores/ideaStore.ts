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
 * écrit l'état du moment où vient son tour. Et un fichier qu'on n'a jamais lu ne s'écrase pas :
 * celui qui revient alors qu'on n'en avait plus se relit avant la première écriture.
 */

import { create } from 'zustand';
import i18n from '../i18n';

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
  /**
   * La disposition automatique du Tableau : pas une modification de l'auteur. Regarder ne date
   * aucune idée, n'écrit rien et ne peut rien faire échouer ; elle s'écrit avec la prochaine
   * vraie modification, et d'ici là se recalcule à l'identique.
   */
  arrangeIdeas: (positions: ReadonlyMap<string, IdeaPosition>) => void;

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
  /** Le projet de cette liste n'est plus ouvert : plus rien à écrire ni à redemander à l'auteur. */
  abandonUnwrittenIdeas: () => void;
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
 * chargent, et `{}` vaut une liste vide depuis le premier jour. Un objet qui porte autre chose
 * n'est pas vide pour autant, même un simple texte : le réécrire le perdrait, il se met de côté.
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
    const holdsOtherData = Object.keys(data).some((key) => key !== 'ideas');
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

/**
 * Un disque qui ne répond plus ne retient pas la file : le projet suivant attendrait derrière
 * lui, sans bannière ni Réessayer. Passé ce délai, la lecture ou l'écriture compte pour un échec,
 * qui se dit et se réessaie. Le verrou du main garde l'ordre si elle finit par aboutir.
 */
const IO_DEADLINE_MS = 15_000;

async function withinDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(i18n.t('ideas.noResponse'))), IO_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * La mise de côté de ce projet, le temps de la fenêtre. `persistence` ne dit que la dernière
 * lecture, et le fichier trouvé ensuite, absent ou neuf, ne dit plus rien : ni un aller-retour
 * vers un autre projet, ni un disque revenu, ni `Cmd+R` ne doivent faire oublier que les idées
 * sont ailleurs. `sessionStorage` survit au rechargement et ne survit pas à la fenêtre.
 */
const backupKey = (projectPath: string) => `cliodeck.ideas.backup:${projectPath}`;

function rememberBackup(projectPath: string, backupPath: string): void {
  try {
    sessionStorage.setItem(backupKey(projectPath), backupPath);
  } catch (error) {
    console.warn('Ideas backup not remembered:', error);
  }
}

function rememberedBackup(projectPath: string): string | null {
  try {
    return sessionStorage.getItem(backupKey(projectPath));
  } catch {
    return null;
  }
}

/**
 * La mise de côté à signaler encore. Si l'auteur l'a remise à sa place ou rangée ailleurs, plus
 * rien à en dire : le message donnerait un chemin qui n'existe plus.
 */
async function standingBackup(projectPath: string): Promise<string | null> {
  const backupPath = rememberedBackup(projectPath);
  return backupPath && (await withinDeadline(window.electron.fs.exists(backupPath))) ? backupPath : null;
}

type LoadedIdeas =
  | { kind: 'ready'; ideas: Idea[]; fileFound: boolean; backupPath: string | null }
  | { kind: 'quarantined'; backupPath: string }
  | { kind: 'blocked'; reason: string };

function persistenceAfter(loaded: LoadedIdeas): IdeaPersistence {
  if (loaded.kind !== 'ready') return loaded;
  return loaded.backupPath ? { kind: 'quarantined', backupPath: loaded.backupPath } : { kind: 'ready' };
}

/** Lire `ideas.json` à l'instant : `null` pour `ideas` si le contenu est à mettre de côté. */
async function readIdeasOnce(ideasPath: string) {
  const read = await withinDeadline(window.electron.fs.readUserFile(ideasPath));
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
    if (ideas) return { kind: 'ready', ideas, fileFound: true, backupPath: await standingBackup(projectPath) };
    if (damaged) {
      // Retenue à la réponse du main, même tardive : le fichier a alors bel et bien bougé.
      const moved = await withinDeadline(
        window.electron.fs.quarantineFile(ideasPath).then((outcome) => {
          if (outcome.success) rememberBackup(projectPath, outcome.backupPath);
          return outcome;
        })
      );
      return moved.success
        ? { kind: 'quarantined', backupPath: moved.backupPath }
        : { kind: 'blocked', reason: moved.error };
    }
    if (read.kind === 'unreadable') return { kind: 'blocked', reason: read.message };
    // `absent` vaut aussi pour un disque débranché : la liste vide s'écrirait à son retour, sur
    // les vraies idées. Le dossier du projet, lui, existe toujours.
    if (!(await withinDeadline(window.electron.fs.exists(projectPath)))) {
      return { kind: 'blocked', reason: projectPath };
    }
    return { kind: 'ready', ideas: [], fileFound: false, backupPath: await standingBackup(projectPath) };
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
/** La liste qu'il n'y a plus à écrire : celle du disque, à une disposition automatique près. */
let writtenIdeas: string | null = null;
/** Le projet chargé sans fichier sur le disque : s'il en vient un, il n'est pas à écraser. */
let noFileFor: string | null = null;

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
      const sameProject = get().loadedFor === projectPath;

      // Le panneau se démonte sans blur, et relire ferait disparaître ce qui n'est pas écrit.
      // Si l'écriture échoue, la liste à l'écran reste la seule copie : elle reste à l'écran.
      if (sameProject && hasUnwrittenIdeas() && !(await writeCurrentIdeas(projectPath))) {
        set({ isLoading: load !== lastLoad });
        return;
      }

      const loaded = await readIdeasFile(projectPath);
      const ideas = loaded.kind === 'ready' ? loaded.ideas : [];
      // Lire n'écrit rien : même normalisée, la liste chargée n'est pas à réécrire.
      writtenIdeas = serializeIdeas(ideas);
      noFileFor = loaded.kind === 'quarantined' || (loaded.kind === 'ready' && !loaded.fileFound) ? projectPath : null;
      set({
        ideas,
        persistence: persistenceAfter(loaded),
        loadedFor: projectPath,
        saveError: null,
        isLoading: load !== lastLoad,
      });
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

  arrangeIdeas: (positions) => {
    const nothingToWrite = !hasUnwrittenIdeas();
    set((state) => ({
      ideas: state.ideas.map((idea) => {
        const position = positions.get(idea.id);
        return position ? { ...idea, position } : idea;
      }),
    }));
    if (nothingToWrite) writtenIdeas = serializeIdeas(get().ideas);
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
    return loadedFor === null ? Promise.resolve() : saveIdeas(loadedFor);
  },

  abandonUnwrittenIdeas: () => {
    writtenIdeas = serializeIdeas(get().ideas);
    set({ saveError: null });
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
 * Le fichier est-il revenu depuis le chargement ? L'auteur a pu réparer celui qu'on avait mis de
 * côté, un service de synchronisation le rendre, et l'écraser perdrait une liste qu'on n'a jamais
 * vue, sans copie si la mise de côté a servi à le réparer. Ce qu'il apporte rejoint la liste à
 * l'écran. Lève s'il ne se lit pas : on ne sait pas ce qu'on écraserait, et la liste à l'écran
 * reste la seule copie de ce qu'a fait l'auteur, donc pas de `blocked`, qui la fermerait.
 */
async function takeInFileThatCameBack(projectPath: string): Promise<void> {
  const loaded = await readIdeasFile(projectPath);
  if (loaded.kind === 'blocked') throw new Error(loaded.reason);
  if (loaded.kind === 'ready') {
    if (!loaded.fileFound) return;
    noFileFor = null;
    useIdeaStore.setState((state) => ({ ideas: [...loaded.ideas, ...state.ideas] }));
  }
  useIdeaStore.setState({ persistence: persistenceAfter(loaded) });
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
  // Rien de neuf : le blur d'un champ non retouché ou un clic sur une carte n'ont rien à écrire,
  // donc rien à faire échouer. Et si l'auteur a défait ce qui ne s'écrivait pas, plus rien à dire.
  if (serializeIdeas(ideas) === writtenIdeas) {
    useIdeaStore.setState({ saveError: null });
    return true;
  }
  try {
    if (noFileFor === projectPath) await takeInFileThatCameBack(projectPath);
    // Après la relecture : ce qui s'est tapé pendant part aussi.
    const data = serializeIdeas(useIdeaStore.getState().ideas);
    await withinDeadline(
      // Retenu à la réponse du main, même tardive : le fichier est alors bel et bien le nôtre.
      window.electron.fs.writeFile(ideasFilePath(projectPath), data).then(() => {
        if (noFileFor === projectPath) noFileFor = null;
      })
    );
    writtenIdeas = data;
    useIdeaStore.setState({ saveError: null });
    return true;
  } catch (error) {
    console.error('Failed to save ideas:', error);
    useIdeaStore.setState({ saveError: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
