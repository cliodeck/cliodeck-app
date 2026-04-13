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

export const BrainstormPanel: React.FC = () => {
  const [hints, setHints] = useState<HintsState | null>(null);
  const [builtin, setBuiltin] = useState<RecipeSummary[]>([]);
  const [user, setUser] = useState<RecipeSummary[]>([]);
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fusion = window.electron.fusion;
        if (!fusion) {
          setLoadError(
            'Fusion API not exposed by preload — rebuild the preload bundle.'
          );
          return;
        }
        const [h, r, v] = await Promise.all([
          fusion.hints.read(),
          fusion.recipes.list(),
          fusion.vault.status(),
        ]);
        if (cancelled) return;

        if (h.success && h.hints) setHints(h.hints);
        else if (h.error === 'no_project') setLoadError('Open a project first.');
        else if (h.error) setLoadError(`Hints: ${h.error}`);

        if (r.success) {
          setBuiltin(r.builtin ?? []);
          setUser(r.user ?? []);
        }
        if (v.success) {
          setVault({ indexed: !!v.indexed, dbPath: v.dbPath ?? '' });
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="brainstorm-panel">
      <header className="brainstorm-panel__header">
        <Lightbulb size={20} />
        <h2>Brainstorm</h2>
        <span className="brainstorm-panel__badge">scaffold</span>
      </header>

      {loadError && (
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

      <section className="brainstorm-panel__section brainstorm-panel__chat-stub">
        <h3>
          <MessageCircle size={14} /> Chat
        </h3>
        <p className="brainstorm-panel__muted">
          Composer arrives in step 3.2 (separate PR).
        </p>
      </section>
    </div>
  );
};
