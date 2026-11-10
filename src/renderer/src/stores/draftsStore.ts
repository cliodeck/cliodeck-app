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
   * inséré ou jeté. Un chemin de dossier comparé tel quel, le renderer ne voyant pas le disque : un
   * projet déplacé ou renommé ne retrouve plus les siens, qui restent dans la file (et le stockage).
   */
  projectPath?: string;
}

interface DraftsState {
  drafts: BrainstormDraft[];
  isPanelOpen: boolean;
  /**
   * Les brouillons dont la proposition attend une décision. Pas persisté : une
   * proposition ne survit pas à la fermeture, et le bouton resterait bloqué.
   */
  proposedIds: string[];

  /**
   * `projectPath` : le projet de la réponse, lu avant toute attente (une bascule a pu montrer un autre
   * projet depuis) ; null sans projet ouvert.
   */
  enqueue: (draft: Omit<BrainstormDraft, 'id' | 'createdAt' | 'projectPath'> & { projectPath: string | null }) => void;
  remove: (id: string) => void;
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

      clear: (projectPath) =>
        set((state) => ({ drafts: state.drafts.filter((d) => !shownIn(d, projectPath)) })),

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

function shownIn(draft: BrainstormDraft, projectPath: string | null): boolean {
  return !draft.projectPath || draft.projectPath === projectPath;
}

/**
 * Les brouillons que montre ce projet : les siens, et ceux sans projet (Q12). Sans projet ouvert,
 * ces derniers seuls. Le panneau, son compteur et « Vider la file » passent par lui.
 */
export function draftsForProject(drafts: readonly BrainstormDraft[], projectPath: string | null): BrainstormDraft[] {
  return drafts.filter((draft) => shownIn(draft, projectPath));
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
