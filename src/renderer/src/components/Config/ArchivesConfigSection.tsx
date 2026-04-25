import React, { useEffect, useState } from 'react';
import { Library, Eye, EyeOff, Check, AlertCircle } from 'lucide-react';

type Connector = 'europeana';

interface ArchivesApi {
  getStatus(): Promise<{
    success: boolean;
    connectors?: { europeana: { configured: boolean } };
    error?: string;
  }>;
  setKey(connector: Connector, key: string): Promise<{
    success: boolean;
    connector?: string;
    error?: string;
  }>;
  deleteKey(connector: Connector): Promise<{
    success: boolean;
    connector?: string;
    error?: string;
  }>;
}

function api(): ArchivesApi | null {
  return (
    (window as unknown as { electron?: { fusion?: { archives?: ArchivesApi } } })
      .electron?.fusion?.archives ?? null
  );
}

export const ArchivesConfigSection: React.FC = () => {
  const [europeanaConfigured, setEuropeanaConfigured] = useState(false);
  const [europeanaInput, setEuropeanaInput] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    const a = api();
    if (!a) {
      setError('API archives non exposée par le preload.');
      return;
    }
    const res = await a.getStatus();
    if (res.success && res.connectors) {
      setEuropeanaConfigured(res.connectors.europeana.configured);
    } else if (res.error) {
      setError(res.error);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleSave = async (): Promise<void> => {
    const a = api();
    if (!a || !europeanaInput.trim()) return;
    setBusy(true);
    setError(null);
    const res = await a.setKey('europeana', europeanaInput);
    setBusy(false);
    if (!res.success) {
      setError(res.error ?? 'Impossible de stocker la clé.');
      return;
    }
    setEuropeanaInput('');
    setRevealed(false);
    await refresh();
    setSavedNotice('Clé Europeana enregistrée (chiffrée par l’OS).');
    window.setTimeout(() => setSavedNotice(null), 3000);
  };

  const handleDelete = async (): Promise<void> => {
    const a = api();
    if (!a) return;
    setBusy(true);
    setError(null);
    const res = await a.deleteKey('europeana');
    setBusy(false);
    if (!res.success) {
      setError(res.error ?? 'Suppression échouée.');
      return;
    }
    await refresh();
    setSavedNotice('Clé Europeana supprimée.');
    window.setTimeout(() => setSavedNotice(null), 3000);
  };

  return (
    <section className="config-section">
      <h3 className="config-section-title">
        <Library size={16} /> Connecteurs d’archives
      </h3>
      <p className="config-hint">
        Activer des connecteurs externes (Europeana, et plus tard Transkribus,
        FranceArchives) en stockant leurs clés API. Les clés sont chiffrées
        par le système d’exploitation (Electron <code>safeStorage</code>) ;
        elles ne sont jamais écrites dans <code>config.json</code> ni
        envoyées avec un projet.
      </p>

      {error && (
        <p
          style={{
            color: 'var(--color-danger)',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <AlertCircle size={14} /> {error}
        </p>
      )}

      <div
        style={{
          padding: 10,
          border: '1px solid var(--border-color)',
          borderRadius: 4,
          background: 'var(--bg-panel)',
          marginBottom: 8,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <div>
            <strong style={{ fontSize: 13 }}>Europeana</strong>{' '}
            <span style={{ fontSize: 11, opacity: 0.7 }}>
              ~50M items GLAM européens (musées, archives, bibliothèques)
            </span>
          </div>
          <span
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 999,
              background: europeanaConfigured
                ? 'color-mix(in srgb, var(--color-accent) 20%, transparent)'
                : 'color-mix(in srgb, var(--text-tertiary) 15%, transparent)',
              color: europeanaConfigured
                ? 'var(--color-accent)'
                : 'var(--text-tertiary)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {europeanaConfigured ? (
              <>
                <Check size={12} /> configurée
              </>
            ) : (
              <>non configurée</>
            )}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type={revealed ? 'text' : 'password'}
            value={europeanaInput}
            onChange={(e) => setEuropeanaInput(e.target.value)}
            placeholder={
              europeanaConfigured
                ? 'Coller une nouvelle clé pour remplacer'
                : 'wskey Europeana (gratuit sur pro.europeana.eu)'
            }
            disabled={busy}
            style={{
              flex: 1,
              fontSize: 12,
              padding: '6px 8px',
              fontFamily: 'monospace',
              background: 'var(--bg-app)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: 3,
            }}
          />
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => setRevealed((v) => !v)}
            disabled={!europeanaInput || busy}
            aria-label={revealed ? 'Masquer la clé' : 'Afficher la clé'}
            title={revealed ? 'Masquer' : 'Afficher'}
            style={{ padding: '6px 8px' }}
          >
            {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => void handleSave()}
            disabled={!europeanaInput.trim() || busy}
          >
            {busy ? '…' : 'Enregistrer'}
          </button>
          {europeanaConfigured && (
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => void handleDelete()}
              disabled={busy}
              style={{ color: 'var(--color-danger)' }}
            >
              Supprimer
            </button>
          )}
        </div>

        <p style={{ fontSize: 11, marginTop: 8, opacity: 0.75 }}>
          Pour utiliser <code>search_europeana</code> depuis un client MCP
          tiers (Claude Desktop), définir aussi{' '}
          <code>EUROPEANA_API_KEY</code> dans la config du client — la clé
          stockée ici est consommée uniquement par le serveur MCP intégré que
          ClioDeck spawne lui-même.
        </p>
      </div>

      {savedNotice && (
        <p style={{ color: 'var(--color-accent)', fontSize: 12 }}>
          {savedNotice}
        </p>
      )}
    </section>
  );
};
