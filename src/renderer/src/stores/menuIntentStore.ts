import { create } from 'zustand';

/**
 * Ce qu'une commande du menu natif demande à un panneau de gauche qui n'est peut-être pas monté :
 * Nouveau projet, Ouvrir un projet, Importer BibTeX. Le menu bascule sur le panneau ; le panneau,
 * monté ou pas encore, consomme l'intention et fait ce que fait son propre bouton. Ces commandes
 * émettaient des événements que personne n'écoutait, et ne faisaient rien (S15-1-30).
 */
export type MenuIntent = 'new-project' | 'open-project' | 'import-bibtex';

interface MenuIntentState {
  intent: MenuIntent | null;
  request: (intent: MenuIntent) => void;
  /** Vrai si `intent` était demandée : elle est alors retirée, et n'agit qu'une fois. */
  consume: (intent: MenuIntent) => boolean;
}

export const useMenuIntentStore = create<MenuIntentState>((set, get) => ({
  intent: null,

  request: (intent) => set({ intent }),

  consume: (intent) => {
    if (get().intent !== intent) return false;
    set({ intent: null });
    return true;
  },
}));
