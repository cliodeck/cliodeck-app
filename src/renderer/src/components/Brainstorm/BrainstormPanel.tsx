/**
 * BrainstormPanel (fusion phase 3.1b — scaffold).
 *
 * The first user-facing surface for the new mode. Intentionally minimal:
 *   - shows the workspace `.cliohints` (read-only here; editor lives in
 *     Settings later);
 *   - lists builtin + user recipes from the IPC bridge;
 *   - shows whether the Obsidian vault is indexed;
 *   - placeholder for the chat composer (3.2, separate PR).
 *
 * Purpose of this scaffold is to *prove the IPC wiring works end-to-end*
 * — open a project, see hints/recipes/vault status, no errors. The real
 * chat surface arrives next.
 */

import React, { useEffect, useState } from 'react';
import { Lightbulb, FileText, Database, MessageCircle } from 'lucide-react';
import { BrainstormChat } from './BrainstormChat';
import { useProjectStore } from '../../stores/projectStore';
import './BrainstormPanel.css';

interface RecipeSummary {
  fileName: string;
  name: string;
  version: string;
  description: string;
  steps: number;
}

interface HintsState {
  present: boolean;
  raw: string;
  normalized: string;
  sourcePath: string;
}

interface VaultStatus {
  indexed: boolean;
  dbPath: string;
}

// Minimal typing of the new fusion API on window.electron — keeps the
// scaffold self-contained until a global ambient declaration is added.
type FusionApi = {
  hints: { read(): Promise<{ success: boolean; hints?: HintsState; error?: string }> };
  recipes: {
    list(): Promise<{
      success: boolean;
      builtin?: RecipeSummary[];
      user?: RecipeSummary[];
      error?: string;
    }>;
  };
  vault: {
    status(): Promise<{ success: boolean; indexed?: boolean; dbPath?: string; error?: string }>;
  };
};

declare global {
  interface Window {
    electron: { fusion?: FusionApi } & Window['electron'];
  }
}

type LoadStatus = 'idle' | 'loading' | 'ready' | 'no_project';

export const BrainstormPanel: React.FC = () => {
  const [hints, setHints] = useState<HintsState | null>(null);
  const [builtin, setBuiltin] = useState<RecipeSummary[]>([]);
  const [user, setUser] = useState<RecipeSummary[]>([]);
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const currentProjectPath = useProjectStore((s) => s.currentProject?.path ?? null);

  useEffect(() => {
    let cancelled = false;

    if (!currentProjectPath) {
      setStatus('no_project');
      setHints(null);
      setBuiltin([]);
      setUser([]);
      setVault(null);
      setLoadError(null);
      return;
    }

    setStatus('loading');
    setLoadError(null);

    (async () => {
      try {
        const fusion = window.electron.fusion;
        if (!fusion) {
          if (!cancelled) {
            setLoadError(
              'Fusion API not exposed by preload — rebuild the preload bundle.'
            );
            setStatus('idle');
          }
          return;
        }
        const [h, r, v] = await Promise.all([
          fusion.hints.read(),
          fusion.recipes.list(),
          fusion.vault.status(),
        ]);
        if (cancelled) return;

        if (h.success && h.hints) {
          setHints(h.hints);
        } else if (h.error === 'no_project') {
          // Project was closed between reads — reflect it cleanly.
          setStatus('no_project');
          return;
        } else if (h.error) {
          setLoadError(`Hints: ${h.error}`);
        }

        if (r.success) {
          setBuiltin(r.builtin ?? []);
          setUser(r.user ?? []);
        }
        if (v.success) {
          setVault({ indexed: !!v.indexed, dbPath: v.dbPath ?? '' });
        }
        setStatus('ready');
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
          setStatus('idle');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentProjectPath]);

  return (
    <div className="brainstorm-panel">
      <header className="brainstorm-panel__header">
        <Lightbulb size={20} />
        <h2>Brainstorm</h2>
        <span className="brainstorm-panel__badge">scaffold</span>
      </header>

      {status === 'no_project' && (
        <div className="brainstorm-panel__notice" role="status">
          Open a project to start brainstorming.
        </div>
      )}

      {loadError && status !== 'no_project' && (
        <div className="brainstorm-panel__error" role="alert">
          {loadError}
        </div>
      )}

      <section className="brainstorm-panel__section">
        <h3>
          <FileText size={14} /> Workspace hints
        </h3>
        {hints?.present ? (
          <pre className="brainstorm-panel__hints">{hints.normalized}</pre>
        ) : (
          <p className="brainstorm-panel__muted">
            No <code>.cliohints</code> set. Add one at{' '}
            <code>{hints?.sourcePath ?? '.cliodeck/v2/hints.md'}</code> to
            inject durable context into every prompt.
          </p>
        )}
      </section>

      <section className="brainstorm-panel__section">
        <h3>
          <Database size={14} /> Obsidian vault
        </h3>
        {vault ? (
          <p className="brainstorm-panel__muted">
            {vault.indexed
              ? `Index ready at ${vault.dbPath}`
              : 'Not indexed yet — link a vault from Settings.'}
          </p>
        ) : (
          <p className="brainstorm-panel__muted">checking…</p>
        )}
      </section>

      <section className="brainstorm-panel__section">
        <h3>Recipes ({builtin.length + user.length})</h3>
        <ul className="brainstorm-panel__recipes">
          {[...builtin, ...user].map((r) => (
            <li key={r.fileName}>
              <strong>{r.name}</strong>{' '}
              <span className="brainstorm-panel__muted">v{r.version}</span>
              <p className="brainstorm-panel__muted">
                {r.description || '—'} · {r.steps} steps
              </p>
            </li>
          ))}
          {builtin.length + user.length === 0 && (
            <li className="brainstorm-panel__muted">No recipes available.</li>
          )}
        </ul>
      </section>

      <section className="brainstorm-panel__section brainstorm-panel__chat-section">
        <h3>
          <MessageCircle size={14} /> Chat
        </h3>
        <div className="brainstorm-panel__chat-host">
          <BrainstormChat />
        </div>
      </section>
    </div>
  );
};
