import { create } from 'zustand';
import type { RebuildProgressEvent } from '@backend/types/rebuild-progress';

interface RebuildState {
  /** Pendant une reconstruction seulement : le voile n'est alors pas fermable. */
  isRebuilding: boolean;
  /** La cause du dernier échec, tant que le message n'est pas fermé. */
  failure: string | null;
  progress: RebuildProgressEvent;
  setRebuildProgress: (progress: RebuildProgressEvent) => void;
  resetProgress: () => void;
}

export const useRebuildStore = create<RebuildState>((set) => ({
  isRebuilding: false,
  failure: null,
  progress: {
    current: 0,
    total: 100,
    status: '',
    percentage: 0,
    phase: 'done',
  },

  setRebuildProgress: (progress: RebuildProgressEvent) => {
    set({
      // La phase, pas le pourcentage : un échec à 0 % passait pour un début, et le
      // voile restait, sans bouton, jusqu'au redémarrage.
      isRebuilding: progress.phase === 'running',
      failure: progress.phase === 'failed' ? (progress.error ?? progress.status) : null,
      progress,
    });
  },

  resetProgress: () => {
    set({
      isRebuilding: false,
      failure: null,
      progress: {
        current: 0,
        total: 100,
        status: '',
        percentage: 0,
        phase: 'done',
      },
    });
  },
}));

// Setup listener on module load
if (typeof window !== 'undefined') {
  window.electron.project.onRebuildProgress((progress) => {
    useRebuildStore.getState().setRebuildProgress(progress);
  });
}
