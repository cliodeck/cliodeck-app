import { create } from 'zustand';

interface RebuildProgress {
  current: number;
  total: number;
  status: string;
  percentage: number;
}

interface RebuildState {
  isRebuilding: boolean;
  progress: RebuildProgress;
  setRebuildProgress: (progress: RebuildProgress) => void;
  resetProgress: () => void;
}

export const useRebuildStore = create<RebuildState>((set) => ({
  isRebuilding: false,
  progress: {
    current: 0,
    total: 100,
    status: '',
    percentage: 0,
  },

  setRebuildProgress: (progress: RebuildProgress) => {
    set({
      isRebuilding: progress.percentage < 100,
      progress,
    });
  },

  resetProgress: () => {
    set({
      isRebuilding: false,
      progress: {
        current: 0,
        total: 100,
        status: '',
        percentage: 0,
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
