import { create } from 'zustand';

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
