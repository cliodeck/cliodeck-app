import React, { useCallback, useEffect, useState } from 'react';
import { Network, Plus, RefreshCw, Trash2, Play } from 'lucide-react';

interface ClientInstance {
  name: string;
  state:
    | 'unconfigured'
    | 'spawning'
    | 'handshaking'
    | 'ready'
    | 'degraded'
    | 'failed'
    | 'stopped';
  lastError?: { code: string; message: string; at: string };
  lastReadyAt?: string;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
  generation: number;
}

interface MCPApi {
  list(): Promise<{ success: boolean; clients?: ClientInstance[]; error?: string }>;
  add(client: {
    name: string;
    transport: 'stdio' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
  }): Promise<{ success: boolean; instance?: ClientInstance; error?: string }>;
  remove(name: string): Promise<{ success: boolean; error?: string }>;
  restart(
    name: string
  ): Promise<{ success: boolean; instance?: ClientInstance; error?: string }>;
  onEvent(cb: (ev: unknown) => void): () => void;
}

function api(): MCPApi | null {
  return (
    (window as unknown as { electron?: { fusion?: { mcp?: MCPApi } } })
      .electron?.fusion?.mcp ?? null
  );
}

type FormState = {
  name: string;
  transport: 'stdio' | 'sse';
  command: string;
  args: string;
  url: string;
};

const EMPTY_FORM: FormState = {
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
};

function stateColor(state: ClientInstance['state']): string {
  switch (state) {
    case 'ready':
      return 'var(--color-accent)';
    case 'failed':
    case 'degraded':
      return 'var(--color-danger)';
    case 'stopped':
    case 'unconfigured':
      return 'var(--text-tertiary)';
    default:
      return 'var(--text-secondary)';
  }
}

export const MCPClientsSection: React.FC = () => {
  const [clients, setClients] = useState<ClientInstance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const refresh = useCallback(async () => {
    const a = api();
    if (!a) {
      setError('Fusion API non exposée.');
      return;
    }
    const res = await a.list();
    if (res.success) {
      setClients(res.clients ?? []);
      setError(null);
    } else {
      setError(res.error ?? 'Liste indisponible.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const a = api();
    const unsub = a?.onEvent(() => {
      void refresh();
    });
    return () => {
      unsub?.();
    };
  }, [refresh]);

  const submit = useCallback(async () => {
    const a = api();
    if (!a) return;
    setBusy(true);
    try {
      const parsedArgs = form.args
        .trim()
        .split(/\s+/)
        .filter((a) => a.length > 0);
      const payload = {
        name: form.name.trim(),
        transport: form.transport,
        command: form.transport === 'stdio' ? form.command.trim() : undefined,
        args:
          form.transport === 'stdio' && parsedArgs.length > 0
            ? parsedArgs
            : undefined,
        url: form.transport === 'sse' ? form.url.trim() : undefined,
      };
      const res = await a.add(payload);
      if (res.success) {
        setForm(EMPTY_FORM);
        setShowForm(false);
        await refresh();
      } else {
        setError(res.error ?? 'Ajout refusé.');
      }
    } finally {
      setBusy(false);
    }
  }, [form, refresh]);

  const remove = useCallback(
    async (name: string) => {
      const a = api();
      if (!a) return;
      setBusy(true);
      try {
        await a.remove(name);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const restart = useCallback(
    async (name: string) => {
      const a = api();
      if (!a) return;
      setBusy(true);
      try {
        await a.restart(name);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  return (
    <section className="config-section">
      <h3 className="config-section-title">
        <Network size={16} /> Clients MCP
      </h3>
      <p className="config-hint">
        Serveurs MCP (Model Context Protocol) externes consommés par
        ClioDeck. Transport <code>stdio</code> (processus local) ou{' '}
        <code>sse</code> (HTTP SSE distant). L'utilisation des outils MCP
        depuis le chat Brainstorm (tool-use) arrive dans une vague suivante —
        pour l'instant cette section sert à configurer les clients et
        vérifier que leurs outils s'exposent correctement.
      </p>

      {error && (
        <p style={{ color: 'var(--color-danger)', fontSize: 12 }}>{error}</p>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => void refresh()}
          disabled={busy}
        >
          <RefreshCw size={14} strokeWidth={1} /> Actualiser
        </button>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => setShowForm((v) => !v)}
          disabled={busy}
        >
          <Plus size={14} strokeWidth={1} />{' '}
          {showForm ? 'Annuler' : 'Ajouter un client'}
        </button>
      </div>

      {showForm && (
        <div
          style={{
            padding: 10,
            border: '1px solid var(--border-color)',
            borderRadius: 4,
            background: 'var(--bg-panel)',
            marginBottom: 12,
          }}
        >
          <div className="config-field">
            <label className="config-label">Nom</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="config-input"
              placeholder="mon-serveur"
            />
          </div>
          <div className="config-field">
            <label className="config-label">Transport</label>
            <select
              value={form.transport}
              onChange={(e) =>
                setForm({ ...form, transport: e.target.value as 'stdio' | 'sse' })
              }
              className="config-input"
            >
              <option value="stdio">stdio (processus local)</option>
              <option value="sse">sse (HTTP SSE distant)</option>
            </select>
          </div>
          {form.transport === 'stdio' ? (
            <>
              <div className="config-field">
                <label className="config-label">Commande</label>
                <input
                  type="text"
                  value={form.command}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                  className="config-input"
                  placeholder="/usr/bin/python, npx, cliodeck-mcp-server…"
                />
              </div>
              <div className="config-field">
                <label className="config-label">
                  Arguments (séparés par espaces)
                </label>
                <input
                  type="text"
                  value={form.args}
                  onChange={(e) => setForm({ ...form, args: e.target.value })}
                  className="config-input"
                  placeholder="--stdio --workspace /path/to/ws"
                />
              </div>
            </>
          ) : (
            <div className="config-field">
              <label className="config-label">URL</label>
              <input
                type="text"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                className="config-input"
                placeholder="https://example.com/mcp/sse"
              />
            </div>
          )}
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => void submit()}
            disabled={
              busy ||
              !form.name.trim() ||
              (form.transport === 'stdio' && !form.command.trim()) ||
              (form.transport === 'sse' && !form.url.trim())
            }
          >
            <Play size={14} strokeWidth={1} /> Enregistrer &amp; démarrer
          </button>
        </div>
      )}

      {clients.length === 0 ? (
        <p className="config-hint" style={{ margin: 0 }}>
          Aucun client MCP configuré pour ce projet.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {clients.map((c) => (
            <li
              key={c.name}
              style={{
                padding: 10,
                border: '1px solid var(--border-color)',
                borderRadius: 4,
                marginBottom: 8,
                background: 'var(--bg-panel)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong>{c.name}</strong>
                <span
                  style={{
                    fontSize: 11,
                    padding: '1px 6px',
                    borderRadius: 3,
                    color: stateColor(c.state),
                    border: `1px solid ${stateColor(c.state)}`,
                  }}
                >
                  {c.state}
                </span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    className="toolbar-btn"
                    onClick={() => void restart(c.name)}
                    disabled={busy}
                    title="Redémarrer"
                    style={{ padding: '2px 6px' }}
                  >
                    <RefreshCw size={12} strokeWidth={1} />
                  </button>
                  <button
                    type="button"
                    className="toolbar-btn"
                    onClick={() => void remove(c.name)}
                    disabled={busy}
                    title="Supprimer"
                    style={{ padding: '2px 6px' }}
                  >
                    <Trash2 size={12} strokeWidth={1} />
                  </button>
                </span>
              </div>
              {c.lastError && (
                <p
                  style={{
                    margin: '4px 0 0',
                    fontSize: 12,
                    color: 'var(--color-danger)',
                  }}
                >
                  {c.lastError.code}: {c.lastError.message}
                </p>
              )}
              {c.tools.length > 0 && (
                <details style={{ marginTop: 6, fontSize: 12 }}>
                  <summary style={{ cursor: 'pointer', opacity: 0.8 }}>
                    Outils exposés ({c.tools.length})
                  </summary>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                    {c.tools.map((t) => (
                      <li key={t.name}>
                        <code>{t.name}</code>
                        {t.description && (
                          <span style={{ opacity: 0.7 }}> — {t.description}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
