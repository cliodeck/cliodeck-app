/**
 * Workspace mode store (fusion phase 3.1a).
 *
 * Distinct from the existing `modeStore` (which controls the LLM assistant
 * "preset"). This one drives the four-mode top-level navigation called for
 * by the fusion plan: Explorer → Brainstorm → Write → Export, with Analyze
 * sitting alongside Write for the existing graph/topic UIs.
 *
 * Persisted across sessions so the user lands back where they were.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type WorkspaceMode = 'brainstorm' | 'write' | 'analyze' | 'export';

export const WORKSPACE_MODES: WorkspaceMode[] = [
  'brainstorm',
  'write',
  'analyze',
  'export',
];

interface WorkspaceModeState {
  active: WorkspaceMode;
  setActive: (m: WorkspaceMode) => void;
}

export const useWorkspaceModeStore = create<WorkspaceModeState>()(
  persist(
    (set) => ({
      active: 'write', // default to existing UX so first run isn't surprising
      setActive: (active) => set({ active }),
    }),
    { name: 'cliodeck-workspace-mode' }
  )
);
