import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Server, Check, Copy } from 'lucide-react';

interface MCPServerState {
  enabled: boolean;
  serverName: string;
  workspaceRoot: string;
  binaryPath: string | null;
}

interface MCPServerApi {
  get(): Promise<{
    success: boolean;
    enabled?: boolean;
    serverName?: string;
    workspaceRoot?: string;
    binaryPath?: string | null;
    error?: string;
  }>;
  set(patch: { enabled?: boolean; serverName?: string }): Promise<{
    success: boolean;
    enabled?: boolean;
    serverName?: string;
    error?: string;
  }>;
}

function api(): MCPServerApi | null {
  return (window.electron?.fusion?.mcpServer as MCPServerApi | undefined) ?? null;
}

type SnippetKind = 'claudeDesktop' | 'claudeCode' | 'generic';

function buildSnippet(
  kind: SnippetKind,
  serverName: string,
  binaryPath: string,
  workspaceRoot: string
): string {
  switch (kind) {
    case 'claudeDesktop':
      return JSON.stringify(
        {
          mcpServers: {
            [serverName]: {
              command: binaryPath,
              args: [workspaceRoot],
            },
          },
        },
        null,
        2
      );
    case 'claudeCode':
      return `claude mcp add ${serverName} -- ${binaryPath} ${workspaceRoot}`;
    case 'generic':
      return `${binaryPath} ${workspaceRoot}`;
  }
}

const CodeBlock: React.FC<{
  text: string;
  copyLabel: string;
  copiedLabel: string;
}> = ({ text, copyLabel, copiedLabel }) => {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <div style={{ position: 'relative', marginTop: 4 }}>
      <pre
        style={{
          margin: 0,
          padding: '10px 12px',
          background: 'var(--bg-app)',
          border: '1px solid var(--border-color)',
          borderRadius: 4,
          fontSize: 12,
          fontFamily:
            'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
          color: 'var(--text-primary)',
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {text}
      </pre>
      <button
        type="button"
        className="toolbar-btn"
        onClick={onCopy}
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          padding: '2px 8px',
          fontSize: 11,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {copied ? <Check size={12} strokeWidth={1.5} /> : <Copy size={12} strokeWidth={1.5} />}
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
};

const TOOL_LIST: ReadonlyArray<{ name: string; defaultK: number }> = [
  { name: 'search_documents', defaultK: 10 },
  { name: 'search_obsidian', defaultK: 10 },
  { name: 'search_tropy', defaultK: 10 },
  { name: 'search_zotero', defaultK: 10 },
  { name: 'graph_neighbors', defaultK: 10 },
  { name: 'entity_context', defaultK: 10 },
  { name: 'search_gallica', defaultK: 10 },
  { name: 'search_hal', defaultK: 10 },
  { name: 'search_europeana', defaultK: 10 },
];

export const MCPServerSection: React.FC = () => {
  const { t } = useTranslation();
  const [state, setState] = useState<MCPServerState | null>(null);
  const [pendingName, setPendingName] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeSnippet, setActiveSnippet] = useState<SnippetKind>('claudeDesktop');

  const refresh = useCallback(async () => {
    const a = api();
    if (!a) {
      setError('Fusion API not exposed.');
      return;
    }
    const res = await a.get();
    if (res.success && typeof res.serverName === 'string' && typeof res.workspaceRoot === 'string') {
      setState({
        enabled: !!res.enabled,
        serverName: res.serverName,
        workspaceRoot: res.workspaceRoot,
        binaryPath: res.binaryPath ?? null,
      });
      setPendingName(res.serverName);
      setError(null);
    } else {
      setError(res.error ?? 'unknown');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(
    async (next: boolean) => {
      const a = api();
      if (!a || !state) return;
      setBusy(true);
      try {
        const res = await a.set({ enabled: next });
        if (res.success) await refresh();
        else setError(res.error ?? 'set_failed');
      } finally {
        setBusy(false);
      }
    },
    [state, refresh]
  );

  const commitName = useCallback(async () => {
    const a = api();
    if (!a || !state) return;
    const trimmed = pendingName.trim();
    if (!trimmed || trimmed === state.serverName) return;
    setBusy(true);
    try {
      const res = await a.set({ serverName: trimmed });
      if (res.success) await refresh();
      else setError(res.error ?? 'set_failed');
    } finally {
      setBusy(false);
    }
  }, [state, pendingName, refresh]);

  const snippet = useMemo(() => {
    if (!state || !state.binaryPath) return null;
    return buildSnippet(activeSnippet, state.serverName, state.binaryPath, state.workspaceRoot);
  }, [activeSnippet, state]);

  return (
    <section className="config-section">
      <h3 className="config-section-title">
        <Server size={16} /> {t('mcpServer.title')}
      </h3>
      <p className="config-hint">{t('mcpServer.hint')}</p>

      {error && (
        <p style={{ color: 'var(--color-danger)', fontSize: 12 }}>{error}</p>
      )}

      {state && (
        <>
          <div className="config-field" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={state.enabled}
                disabled={busy}
                onChange={(e) => void toggle(e.target.checked)}
              />
              <span>{t('mcpServer.toggle')}</span>
            </label>
            <span
              style={{
                fontSize: 11,
                padding: '1px 6px',
                borderRadius: 3,
                color: state.enabled ? 'var(--color-accent)' : 'var(--text-tertiary)',
                border: `1px solid ${state.enabled ? 'var(--color-accent)' : 'var(--text-tertiary)'}`,
              }}
            >
              {state.enabled ? 'on' : 'off'}
            </span>
          </div>

          {!state.enabled && (
            <p className="config-hint" style={{ marginTop: -4 }}>
              {t('mcpServer.disabledNote')}
            </p>
          )}

          <div className="config-field">
            <label className="config-label">{t('mcpServer.serverName')}</label>
            <input
              type="text"
              value={pendingName}
              onChange={(e) => setPendingName(e.target.value)}
              onBlur={() => void commitName()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className="config-input"
              placeholder={t('mcpServer.serverNamePlaceholder')}
              disabled={busy}
            />
            <p className="config-hint" style={{ margin: '4px 0 0' }}>
              {t('mcpServer.serverNameHint')}
            </p>
          </div>

          <div className="config-field">
            <label className="config-label">{t('mcpServer.binary')}</label>
            {state.binaryPath ? (
              <code
                style={{
                  display: 'block',
                  padding: '6px 8px',
                  background: 'var(--bg-app)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 4,
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  wordBreak: 'break-all',
                }}
              >
                {state.binaryPath}
              </code>
            ) : (
              <p style={{ color: 'var(--color-danger)', fontSize: 12, margin: 0 }}>
                {t('mcpServer.binaryMissing')}
              </p>
            )}
          </div>

          <div className="config-field">
            <label className="config-label">{t('mcpServer.tools.title')}</label>
            <ul
              style={{
                listStyle: 'none',
                padding: '6px 10px',
                margin: 0,
                background: 'var(--bg-panel)',
                border: '1px solid var(--border-color)',
                borderRadius: 4,
                fontSize: 12,
                columnCount: 2,
                columnGap: 16,
              }}
            >
              {TOOL_LIST.map((tool) => (
                <li
                  key={tool.name}
                  style={{ breakInside: 'avoid', padding: '2px 0' }}
                >
                  <code>{tool.name}</code>
                </li>
              ))}
            </ul>
            <p className="config-hint" style={{ margin: '4px 0 0' }}>
              {t('mcpServer.tools.limits')}
            </p>
          </div>

          {state.binaryPath && (
            <div className="config-field">
              <label className="config-label">{t('mcpServer.snippets.title')}</label>
              <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                {(['claudeDesktop', 'claudeCode', 'generic'] as SnippetKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className="toolbar-btn"
                    onClick={() => setActiveSnippet(k)}
                    style={{
                      padding: '2px 10px',
                      fontSize: 12,
                      borderColor:
                        activeSnippet === k
                          ? 'var(--color-accent)'
                          : 'var(--border-color)',
                      color:
                        activeSnippet === k
                          ? 'var(--color-accent)'
                          : 'var(--text-primary)',
                    }}
                  >
                    {t(`mcpServer.snippets.${k}`)}
                  </button>
                ))}
              </div>
              <p className="config-hint" style={{ margin: '0 0 4px' }}>
                {t(`mcpServer.snippets.${activeSnippet}Hint`)}
              </p>
              {snippet && (
                <CodeBlock
                  text={snippet}
                  copyLabel={t('mcpServer.snippets.copy')}
                  copiedLabel={t('mcpServer.snippets.copied')}
                />
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
};
