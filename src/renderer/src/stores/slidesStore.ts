import { create } from 'zustand';
import { projectLifecycle } from '../lifecycle/projectLifecycle';

interface SlidesGenerationState {
  isPanelOpen: boolean;
  isPreviewOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  togglePreview: () => void;
  closePreview: () => void;
}

export const useSlidesStore = create<SlidesGenerationState>((set) => ({
  isPanelOpen: false,
  isPreviewOpen: false,
  openPanel: () => set({ isPanelOpen: true }),
  closePanel: () => set({ isPanelOpen: false }),
  togglePreview: () => set((s) => ({ isPreviewOpen: !s.isPreviewOpen })),
  closePreview: () => set({ isPreviewOpen: false }),
}));

// Le panneau de génération et l'aperçu portent sur les diapositives du projet quitté.
projectLifecycle.onReset('slides', () => useSlidesStore.setState({ isPanelOpen: false, isPreviewOpen: false }));
