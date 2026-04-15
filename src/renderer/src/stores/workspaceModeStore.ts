/**
 * Workspace mode store (fusion phase 3.1a).
 *
 * Distinct from the existing `modeStore` (which controls the LLM assistant
 * "preset"). This one drives the four-mode top-level navigation called for
 * by the fusion plan: Explorer → Brainstorm → Write → Export, with Analyze
 * sitting alongside Write for the existing graph/topic UIs.
 *
 * Persisted across sessions so the user lands back where they were.
 *
 * Also remembers, *per mode*, which right-panel tab the user last viewed,
 * so switching Write → Brainstorm → Write doesn't force them back to a
 * default tab.
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

// Keep in sync with the RightPanelView union in MainLayout.tsx.
export type RightPanelView = 'chat' | 'corpus' | 'journal';

// Sensible defaults on first entry into a mode.
// - write/analyze/export: chat is the most useful companion tab.
// - brainstorm: the center panel already hosts the chat, so default to
//   corpus (chat tab is hidden in brainstorm anyway).
const DEFAULT_RIGHT_VIEW: Record<WorkspaceMode, RightPanelView> = {
  write: 'chat',
  analyze: 'chat',
  export: 'chat',
  brainstorm: 'corpus',
};

interface WorkspaceModeState {
  active: WorkspaceMode;
  rightViewByMode: Record<WorkspaceMode, RightPanelView>;
  setActive: (m: WorkspaceMode) => void;
  setRightView: (mode: WorkspaceMode, view: RightPanelView) => void;
  getRightView: (mode: WorkspaceMode) => RightPanelView;
}

export const useWorkspaceModeStore = create<WorkspaceModeState>()(
  persist(
    (set, get) => ({
      active: 'write', // default to existing UX so first run isn't surprising
      rightViewByMode: { ...DEFAULT_RIGHT_VIEW },
      setActive: (active) => set({ active }),
      setRightView: (mode, view) =>
        set((state) => ({
          rightViewByMode: { ...state.rightViewByMode, [mode]: view },
        })),
      getRightView: (mode) =>
        get().rightViewByMode[mode] ?? DEFAULT_RIGHT_VIEW[mode],
    }),
    {
      name: 'cliodeck-workspace-mode',
      // Merge stored state onto defaults so adding a new mode (or a fresh
      // install post-upgrade) doesn't leave its slot undefined.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<WorkspaceModeState>;
        return {
          ...current,
          ...p,
          rightViewByMode: {
            ...DEFAULT_RIGHT_VIEW,
            ...(p.rightViewByMode ?? {}),
          },
        };
      },
    }
  )
);
