/**
 * Workspace mode store (fusion phase 3.1a).
 *
 * Distinct from the existing `modeStore` (which controls the LLM assistant
 * "preset"). This one drives the four-mode top-level navigation called for
 * by the fusion plan: Explore → Brainstorm → Write → Export.
 *
 * Persisted across sessions so the user lands back where they were.
 *
 * Also remembers, *per mode*, which right-panel tab the user last viewed,
 * so switching Write → Brainstorm → Write doesn't force them back to a
 * default tab.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type WorkspaceMode = 'explore' | 'brainstorm' | 'write' | 'export';

export const WORKSPACE_MODES: WorkspaceMode[] = [
  'explore',
  'brainstorm',
  'write',
  'export',
];

// Keep in sync with the RightPanelView union in MainLayout.tsx.
export type RightPanelView = 'chat' | 'journal';

// Sensible defaults on first entry into a mode.
// - brainstorm: the center panel already hosts the chat, so default to journal.
// - others: chat is the most useful companion tab.
const DEFAULT_RIGHT_VIEW: Record<WorkspaceMode, RightPanelView> = {
  explore: 'chat',
  brainstorm: 'journal',
  write: 'chat',
  export: 'chat',
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
      version: 2,
      // Migrate persisted 'analyze' → 'explore' (A10 rename) + remove 'corpus' right view (A19).
      migrate: (persisted: unknown, fromVersion: number) => {
        if (fromVersion < 2 && persisted && typeof persisted === 'object') {
          const p = persisted as Record<string, unknown>;
          if (p.active === 'analyze') p.active = 'explore';
          const rvm = p.rightViewByMode as Record<string, string> | undefined;
          if (rvm) {
            if ('analyze' in rvm) {
              rvm.explore = rvm.analyze === 'corpus' ? 'chat' : rvm.analyze;
              delete rvm.analyze;
            }
            // 'corpus' is no longer a valid right view — migrate to 'chat'
            for (const key of Object.keys(rvm)) {
              if (rvm[key] === 'corpus') rvm[key] = 'chat';
            }
          }
        }
        return persisted as never;
      },
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
