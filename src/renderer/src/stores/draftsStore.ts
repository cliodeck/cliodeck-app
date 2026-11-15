/**
 * File de brouillons Brainstorm → Écriture (#7, A13 option c).
 *
 * L'option a (proposition immédiate au curseur, `insertDraftAtCursor`)
 * reste le chemin principal ; cette file est le sas OPTIONNEL pour les
 * sessions longues : mettre de côté plusieurs réponses, les trier, en
 * proposer certaines, jeter le reste — sans qu'elles touchent le
 * manuscrit avant décision. Un brouillon ne la quitte qu'une fois accepté :
 * rejeté, invalidé ou expiré, son texte ne serait plus nulle part.
 *
 * Persisté (localStorage) : la file et l'état ouvert/fermé du panneau
 * survivent au changement de mode d'espace de travail et au redémarrage
 * (signal d'acceptation de l'issue). La file est une pour tous les projets,
 * mais chaque brouillon porte le sien et ne se montre que dans lui
 * (`draftsForProject`, décision Q12) : rien ne la vide quand on en change.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface BrainstormDraft {
  id: string;
  content: string;
  /** ISO 8601 — affiché et utilisé pour le tri (plus récent en tête). */
  createdAt: string;
  /** Modèle + tâche d'origine — transmis à la proposition à l'insertion. */
  source?: { model?: string; task?: string };
  /**
   * Le projet de la réponse : le brouillon ne se montre que dans lui. Absent pour un brouillon d'avant
   * cette règle, ou mis de côté sans projet ouvert : il se montre partout, jusqu'à ce qu'il soit
   * inséré ou jeté. Un chemin de dossier, comparé tel quel, puis par la clé que le main relève sur
   * le disque (`projectPlaces`) : un projet rouvert sous un chemin qui ne diffère que par la casse,
   * ou par un lien, retrouve les siens. Un projet déplacé, renommé ou supprimé ne les retrouve pas :
   * ils vont dans « Brouillons d'autres projets » (`draftsOfMissingProjects`, J12).
   */
  projectPath?: string;
}

/**
 * Où est le projet d'un brouillon, d'après le main (`project:locate`, J12) : `project.json` à son
 * chemin, avec la clé du dossier ; plus là ; ou sans réponse dans le délai (volume qui ne répond
 * pas), ni présent ni absent.
 */
export type DraftProjectPlace = { state: 'present'; key: string } | { state: 'absent' } | { state: 'unknown' };

interface DraftsState {
  drafts: BrainstormDraft[];
  isPanelOpen: boolean;
  /**
   * Les brouillons dont la proposition attend une décision. Pas persisté : une
   * proposition ne survit pas à la fermeture, et le bouton resterait bloqué.
   */
  proposedIds: string[];
  /**
   * Où sont les projets des brouillons, par chemin, relu sur le disque par le main
   * (`locateDraftProjects`). Pas persisté : un dossier peut revenir ou partir d'un lancement à
   * l'autre.
   */
  projectPlaces: Record<string, DraftProjectPlace>;

  /**
   * `projectPath` : le projet de la réponse, lu avant toute attente (une bascule a pu montrer un autre
   * projet depuis) ; null sans projet ouvert.
   */
  enqueue: (draft: Omit<BrainstormDraft, 'id' | 'createdAt' | 'projectPath'> & { projectPath: string | null }) => void;
  remove: (id: string) => void;
  /** Rattache le brouillon à ce projet : il se montre désormais dans lui (J12). */
  attach: (id: string, projectPath: string) => void;
  /** Jette ce que ce projet montre (`draftsForProject`) : les brouillons des autres projets restent. */
  clear: (projectPath: string | null) => void;
  setProposed: (id: string, proposed: boolean) => void;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
}

export const useDraftsStore = create<DraftsState>()(
  persist(
    (set) => ({
      drafts: [],
      isPanelOpen: false,
      proposedIds: [],
      projectPlaces: {},

      enqueue: ({ projectPath, ...draft }) =>
        set((state) => ({
          drafts: [
            {
              ...draft,
              ...(projectPath === null ? {} : { projectPath }),
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
            },
            ...state.drafts,
          ],
        })),

      remove: (id) =>
        set((state) => ({ drafts: state.drafts.filter((d) => d.id !== id) })),

      attach: (id, projectPath) =>
        set((state) => ({ drafts: state.drafts.map((d) => (d.id === id ? { ...d, projectPath } : d)) })),

      clear: (projectPath) =>
        set((state) => ({ drafts: state.drafts.filter((d) => !shownIn(d, projectPath, state.projectPlaces)) })),

      setProposed: (id, proposed) =>
        set((state) => ({
          proposedIds: proposed
            ? [...state.proposedIds.filter((d) => d !== id), id]
            : state.proposedIds.filter((d) => d !== id),
        })),

      openPanel: () => set({ isPanelOpen: true }),
      closePanel: () => set({ isPanelOpen: false }),
      togglePanel: () => set((state) => ({ isPanelOpen: !state.isPanelOpen })),
    }),
    {
      name: 'cliodeck-drafts',
      partialize: ({ drafts, isPanelOpen }) => ({ drafts, isPanelOpen }),
    }
  )
);

/** Deux chemins dont le main a trouvé le même dossier sur le disque (casse, lien). */
function sameProject(places: Record<string, DraftProjectPlace>, a: string, b: string): boolean {
  const [pa, pb] = [places[a], places[b]];
  return pa?.state === 'present' && pb?.state === 'present' && pa.key === pb.key;
}

function shownIn(
  draft: BrainstormDraft,
  projectPath: string | null,
  places: Record<string, DraftProjectPlace> = {}
): boolean {
  if (!draft.projectPath || draft.projectPath === projectPath) return true;
  return projectPath !== null && sameProject(places, draft.projectPath, projectPath);
}

/**
 * Les brouillons que montre ce projet : les siens, et ceux sans projet (Q12). Sans projet ouvert,
 * ces derniers seuls. Les siens comprennent ceux d'un chemin qui mène au même dossier (`places`).
 * Le panneau, son compteur et « Vider la file » passent par lui.
 */
export function draftsForProject(
  drafts: readonly BrainstormDraft[],
  projectPath: string | null,
  places: Record<string, DraftProjectPlace> = {}
): BrainstormDraft[] {
  return drafts.filter((draft) => shownIn(draft, projectPath, places));
}

/**
 * « Brouillons d'autres projets » (J12) : ceux dont le projet n'est plus à son chemin (dossier
 * déplacé, renommé, supprimé, ou disque débranché), à rattacher au projet ouvert ou à jeter. Ceux
 * d'un autre projet présent restent à ce projet (Q12) ; ceux d'un chemin qui ne répond pas, aussi.
 */
export function draftsOfMissingProjects(
  drafts: readonly BrainstormDraft[],
  projectPath: string | null,
  places: Record<string, DraftProjectPlace>
): BrainstormDraft[] {
  if (projectPath === null) return [];
  return drafts.filter(
    (draft) =>
      draft.projectPath !== undefined &&
      !shownIn(draft, projectPath, places) &&
      places[draft.projectPath]?.state === 'absent'
  );
}

/** Les chemins de projet que nomment les brouillons, sauf celui-ci, une fois chacun. */
function otherProjectPaths(drafts: readonly BrainstormDraft[], projectPath: string | null): string[] {
  const paths = drafts.map((d) => d.projectPath).filter((p): p is string => !!p && p !== projectPath);
  return [...new Set(paths)];
}

/** Au plus autant de chemins par demande (`LOCATE_MAX_PATHS`, côté main). */
const LOCATE_MAX_PATHS = 100;
let locateRequest = 0;

/**
 * Demande au main où sont les projets des brouillons (`project:locate`), avec le projet ouvert pour
 * comparer les clés. Rien à demander sans projet ouvert, ni quand tous les brouillons sont les siens
 * ou sans projet. Une réponse arrivée après une demande plus récente est écartée. Un échec laisse
 * les brouillons comparés par leur chemin seul : une réponse d'avant ne dit plus où sont les projets.
 */
export async function locateDraftProjects(projectPath: string | null): Promise<void> {
  const request = ++locateRequest;
  const others = otherProjectPaths(useDraftsStore.getState().drafts, projectPath);
  if (projectPath === null || others.length === 0) {
    useDraftsStore.setState({ projectPlaces: {} });
    return;
  }
  let places: Record<string, DraftProjectPlace> = {};
  try {
    const result = await window.electron.project.locate([projectPath, ...others].slice(0, LOCATE_MAX_PATHS));
    if (result.success && result.places) {
      places = Object.fromEntries(result.places.map(({ path, ...place }) => [path, place]));
    }
  } catch (error: unknown) {
    console.warn('[drafts] project:locate a échoué :', error);
  }
  if (request === locateRequest) useDraftsStore.setState({ projectPlaces: places });
}

/**
 * Relit où sont les projets des brouillons quand le projet ouvert change, quand la file nomme
 * d'autres projets, et à chaque `refresh` (l'ouverture du panneau : un dossier a pu partir ou
 * revenir entre-temps). Le compteur de la barre d'outils et le panneau lisent `projectPlaces`.
 */
export function useLocateDraftProjects(projectPath: string | null, refresh: unknown): void {
  const paths = useDraftsStore((s) => otherProjectPaths(s.drafts, projectPath).join('\n'));
  useEffect(() => {
    void locateDraftProjects(projectPath);
  }, [projectPath, paths, refresh]);
}

/** Première ligne non vide, tronquée — le « titre » d'un brouillon. */
export function draftTitle(draft: BrainstormDraft): string {
  const line =
    draft.content
      .split('\n')
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find((l) => l.length > 0) ?? '';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || '(vide)';
}
