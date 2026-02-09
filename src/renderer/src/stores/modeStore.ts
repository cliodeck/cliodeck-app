import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ResolvedMode, ModeCategory } from '../../../../backend/types/mode';

// MARK: - Types

interface ModeState {
  // Active mode
  activeModeId: string;
  activeMode: ResolvedMode | null;

  // All available modes
  modes: ResolvedMode[];
  isLoadingModes: boolean;

  // Filter state (for UI category tabs)
  categoryFilter: ModeCategory | 'all';

  // Actions
  loadModes: () => Promise<void>;
  setActiveMode: (modeId: string) => Promise<void>;
  setCategoryFilter: (category: ModeCategory | 'all') => void;
  getFilteredModes: () => ResolvedMode[];
  checkModelCompatibility: (currentModel: string) => {
    compatible: boolean;
    warning?: string;
  };

  // CRUD for custom modes
  saveCustomMode: (mode: any, target: 'global' | 'project') => Promise<void>;
  deleteCustomMode: (modeId: string, source: 'global' | 'project') => Promise<void>;
  importMode: (target: 'global' | 'project') => Promise<void>;
  exportMode: (modeId: string) => Promise<void>;
}

// MARK: - Store

export const useModeStore = create<ModeState>()(
  persist(
    (set, get) => ({
      activeModeId: 'default-assistant',
      activeMode: null,
      modes: [],
      isLoadingModes: false,
      categoryFilter: 'all',

      loadModes: async () => {
        set({ isLoadingModes: true });
        try {
          const result = await window.electron.mode.getAll();
          if (result.success && result.modes) {
            const modes = result.modes as ResolvedMode[];
            const activeMode =
              modes.find((m) => m.metadata.id === get().activeModeId) || modes[0] || null;
            set({ modes, activeMode, isLoadingModes: false });
          } else {
            console.warn('⚠️ Failed to load modes:', result.error);
            set({ isLoadingModes: false });
          }
        } catch (error) {
          console.warn('⚠️ Could not load modes:', error);
          set({ isLoadingModes: false });
        }
      },

      setActiveMode: async (modeId: string) => {
        try {
          await window.electron.mode.setActive(modeId);
          const mode = get().modes.find((m) => m.metadata.id === modeId) || null;
          set({ activeModeId: modeId, activeMode: mode });

          // Apply mode's generation params and RAG overrides to ragQueryStore
          if (mode) {
            const { useRAGQueryStore } = await import('./ragQueryStore');
            const overrides: Record<string, any> = {
              temperature: mode.generationParams.temperature,
              top_p: mode.generationParams.top_p,
              top_k: mode.generationParams.top_k,
              repeat_penalty: mode.generationParams.repeat_penalty,
            };

            // Only apply defined RAG overrides
            const rag = mode.ragOverrides;
            if (rag.topK !== undefined) overrides.topK = rag.topK;
            if (rag.sourceType !== undefined) overrides.sourceType = rag.sourceType;
            if (rag.numCtx !== undefined) overrides.numCtx = rag.numCtx;

            useRAGQueryStore.getState().setParams(overrides);
            console.log(`✅ Mode activated: ${modeId}`, overrides);
          }
        } catch (error) {
          console.error('❌ Failed to set active mode:', error);
        }
      },

      setCategoryFilter: (category: ModeCategory | 'all') => {
        set({ categoryFilter: category });
      },

      getFilteredModes: () => {
        const { modes, categoryFilter } = get();
        if (categoryFilter === 'all') return modes;
        return modes.filter((m) => m.metadata.category === categoryFilter);
      },

      checkModelCompatibility: (currentModel: string) => {
        const { activeMode } = get();
        if (!activeMode || !activeMode.modelRecommendation) {
          return { compatible: true };
        }

        const rec = activeMode.modelRecommendation;

        // Check if embedded model is being used with a non-compatible mode
        if (
          currentModel.includes('qwen2.5-0.5b') ||
          currentModel.includes('embedded')
        ) {
          if (!rec.embeddedCompatible) {
            const lang =
              (document.documentElement.lang as 'fr' | 'en') || 'fr';
            return {
              compatible: false,
              warning: rec.warningMessage?.[lang] || rec.warningMessage?.fr,
            };
          }
        }

        return { compatible: true };
      },

      saveCustomMode: async (mode: any, target: 'global' | 'project') => {
        try {
          await window.electron.mode.save(mode, target);
          await get().loadModes();
          console.log(`✅ Custom mode saved: ${mode.metadata?.id}`);
        } catch (error) {
          console.error('❌ Failed to save custom mode:', error);
          throw error;
        }
      },

      deleteCustomMode: async (modeId: string, source: 'global' | 'project') => {
        try {
          await window.electron.mode.delete(modeId, source);
          // If we deleted the active mode, switch to default
          if (get().activeModeId === modeId) {
            await get().setActiveMode('default-assistant');
          }
          await get().loadModes();
          console.log(`🗑️ Custom mode deleted: ${modeId}`);
        } catch (error) {
          console.error('❌ Failed to delete custom mode:', error);
          throw error;
        }
      },

      importMode: async (target: 'global' | 'project') => {
        try {
          const result = await window.electron.dialog.openFile({
            filters: [{ name: 'Mode JSON', extensions: ['json'] }],
            properties: ['openFile'],
          });

          if (result.canceled || !result.filePaths?.[0]) return;

          await window.electron.mode.import(result.filePaths[0], target);
          await get().loadModes();
          console.log(`📦 Mode imported from: ${result.filePaths[0]}`);
        } catch (error) {
          console.error('❌ Failed to import mode:', error);
          throw error;
        }
      },

      exportMode: async (modeId: string) => {
        try {
          const result = await window.electron.dialog.saveFile({
            defaultPath: `${modeId}.json`,
            filters: [{ name: 'Mode JSON', extensions: ['json'] }],
          });

          if (result.canceled || !result.filePath) return;

          await window.electron.mode.export(modeId, result.filePath);
          console.log(`📦 Mode exported to: ${result.filePath}`);
        } catch (error) {
          console.error('❌ Failed to export mode:', error);
          throw error;
        }
      },
    }),
    {
      name: 'cliodeck-active-mode',
      // Only persist the active mode ID, not the full mode list
      partialize: (state) => ({ activeModeId: state.activeModeId }),
    },
  ),
);
