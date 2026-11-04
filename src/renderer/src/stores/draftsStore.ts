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
 * (signal d'acceptation de l'issue). La file est commune à tous les projets.
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
}

interface DraftsState {
  drafts: BrainstormDraft[];
  isPanelOpen: boolean;
  /**
   * Les brouillons dont la proposition attend une décision. Pas persisté : une
   * proposition ne survit pas à la fermeture, et le bouton resterait bloqué.
   */
  proposedIds: string[];

  enqueue: (draft: Omit<BrainstormDraft, 'id' | 'createdAt'>) => void;
  remove: (id: string) => void;
  clear: () => void;
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

      enqueue: (draft) =>
        set((state) => ({
          drafts: [
            {
              ...draft,
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
            },
            ...state.drafts,
          ],
        })),

      remove: (id) =>
        set((state) => ({ drafts: state.drafts.filter((d) => d.id !== id) })),

      clear: () => set({ drafts: [] }),

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

/** Première ligne non vide, tronquée — le « titre » d'un brouillon. */
export function draftTitle(draft: BrainstormDraft): string {
  const line =
    draft.content
      .split('\n')
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find((l) => l.length > 0) ?? '';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || '(vide)';
}
