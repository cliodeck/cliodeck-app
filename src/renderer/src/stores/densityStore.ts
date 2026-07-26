/**
 * Densité de l'interface : confortable (défaut) ou compacte.
 *
 * Le hook `useDensity` qui portait cela n'était importé nulle part, et les
 * ~30 lignes de `body.density-compact` d'`index.css` — tout un barème
 * d'espacement et trois tailles de police — n'étaient donc jamais
 * activées. Du travail fait, inatteignable.
 *
 * Passage au motif zustand du dépôt plutôt qu'un hook à état local : la
 * densité est lue à deux endroits (appliquée au démarrage, réglée depuis
 * les Préférences) et deux instances d'un `useState` se seraient
 * contredites — celle des Préférences posant la classe, celle de l'App la
 * retirant au rendu suivant.
 */
import { create } from 'zustand';

export type Density = 'comfortable' | 'compact';

const STORAGE_KEY = 'ui-density';

function readStored(): Density {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

/** Pose ou retire la classe qui active le barème compact. */
function applyToBody(density: Density): void {
  document.body.classList.toggle('density-compact', density === 'compact');
}

interface DensityState {
  density: Density;
  setDensity: (density: Density) => void;
  /** Applique la densité persistée au démarrage. */
  initialize: () => void;
}

export const useDensityStore = create<DensityState>((set) => ({
  density: 'comfortable',

  setDensity: (density: Density) => {
    applyToBody(density);
    try {
      localStorage.setItem(STORAGE_KEY, density);
    } catch {
      // Densité non persistée : sans conséquence pour la session en cours.
    }
    set({ density });
  },

  initialize: () => {
    const stored = readStored();
    applyToBody(stored);
    set({ density: stored });
  },
}));
