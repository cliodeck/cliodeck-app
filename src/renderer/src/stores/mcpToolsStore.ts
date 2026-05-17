/**
 * mcpToolsStore (fusion 2.5).
 *
 * Tracks per-tool opt-in/opt-out for the MCP tool catalogue surfaced in
 * Brainstorm. The model A12 selected is **auto-enable read-only,
 * opt-in for write/network**: each tool has a kind (`'read' | 'write'`)
 * derived from its bare name; the *default* is `kind === 'read'`. This
 * store only persists the **explicit overrides** the user has set —
 * if the user removes a tool kind from the heuristic later, the
 * override stays.
 *
 * Persisted to `localStorage` so the user's choices survive app
 * restarts. Indexed by namespaced tool name (`clientName__bareName`)
 * exactly as `fusion-chat-service.ts` and the LLM see it on the wire.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { MCPToolKind } from '../../../../backend/integrations/mcp-clients/tool-classifier';
import { classifyMcpTool } from '../../../../backend/integrations/mcp-clients/tool-classifier';

/** Minimal shape we need from a registered MCP tool. */
export interface MCPToolDescriptor {
  /** Namespaced — `${clientName}__${bareName}`. */
  namespaced: string;
  clientName: string;
  bareName: string;
  description?: string;
}

interface State {
  /**
   * Explicit user overrides keyed by namespaced name. Absence means
   * "use the kind-based default". Stored as a Record (not a Map) so
   * Zustand's `persist` middleware can JSON-serialise it.
   */
  overrides: Record<string, boolean>;
  setEnabled: (namespaced: string, enabled: boolean) => void;
  resetTool: (namespaced: string) => void;
  resetAll: () => void;
}

/**
 * Compute the effective enabled state for a tool given the user's
 * overrides + its kind. Default-enable read tools, default-disable
 * writes.
 */
export function computeEffectiveEnabled(
  bareName: string,
  override: boolean | undefined
): boolean {
  if (typeof override === 'boolean') return override;
  return classifyMcpTool(bareName) === 'read';
}

/**
 * Filter a list of registered MCP tools down to the namespaced names
 * the user has effectively enabled. Pass the result to `chat.start` as
 * `enabledTools`.
 */
export function selectEnabledToolNames(
  tools: readonly MCPToolDescriptor[],
  overrides: Record<string, boolean>
): string[] {
  const out: string[] = [];
  for (const t of tools) {
    if (computeEffectiveEnabled(t.bareName, overrides[t.namespaced])) {
      out.push(t.namespaced);
    }
  }
  return out;
}

/**
 * Group tools by their classified kind. Used by the management popup
 * to render two sections (auto-enabled reads vs opt-in writes).
 */
export function groupToolsByKind(
  tools: readonly MCPToolDescriptor[]
): Record<MCPToolKind, MCPToolDescriptor[]> {
  const out: Record<MCPToolKind, MCPToolDescriptor[]> = { read: [], write: [] };
  for (const t of tools) {
    const k = classifyMcpTool(t.bareName);
    out[k].push(t);
  }
  return out;
}

export const useMcpToolsStore = create<State>()(
  persist(
    (set) => ({
      overrides: {},
      setEnabled: (namespaced, enabled) =>
        set((s) => ({
          overrides: { ...s.overrides, [namespaced]: enabled },
        })),
      resetTool: (namespaced) =>
        set((s) => {
          const next = { ...s.overrides };
          delete next[namespaced];
          return { overrides: next };
        }),
      resetAll: () => set({ overrides: {} }),
    }),
    {
      name: 'cliodeck-mcp-tools-v1',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // Only persist the override map — no UI state to keep.
      partialize: (state) => ({ overrides: state.overrides }),
    }
  )
);
