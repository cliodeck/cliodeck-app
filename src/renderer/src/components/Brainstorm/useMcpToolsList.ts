/**
 * useMcpToolsList (fusion 2.5).
 *
 * Subscribes to `fusion:mcp:event` and re-pulls `fusion:mcp:list`
 * whenever a client transitions in/out of `ready`. Returns the flat
 * list of `MCPToolDescriptor` derived from every ready client's
 * declared tools.
 *
 * Returning a stable array reference is intentional — the consumer
 * (`useBrainstormChat`) reads it through a ref to avoid recreating
 * the `send` callback every chat turn.
 */

import { useEffect, useState } from 'react';
import type { MCPToolDescriptor } from '../../stores/mcpToolsStore';

interface MCPApi {
  list(): Promise<{
    success: boolean;
    clients?: Array<{
      name: string;
      state: string;
      tools: Array<{
        name: string;
        description?: string;
      }>;
    }>;
    error?: string;
  }>;
  onEvent(cb: (ev: unknown) => void): () => void;
}

function api(): MCPApi | null {
  return (window.electron?.fusion?.mcp as MCPApi | undefined) ?? null;
}

const EMPTY: readonly MCPToolDescriptor[] = [];

export function useMcpToolsList(): readonly MCPToolDescriptor[] {
  const [tools, setTools] = useState<readonly MCPToolDescriptor[]>(EMPTY);

  useEffect(() => {
    const a = api();
    if (!a) return;

    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const res = await a.list();
      if (cancelled || !res.success || !res.clients) return;
      const next: MCPToolDescriptor[] = [];
      for (const c of res.clients) {
        if (c.state !== 'ready') continue;
        for (const t of c.tools) {
          next.push({
            namespaced: `${c.name}__${t.name}`,
            clientName: c.name,
            bareName: t.name,
            description: t.description,
          });
        }
      }
      setTools(next);
    };

    void refresh();
    const unsub = a.onEvent(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  return tools;
}
