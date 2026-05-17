import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Check, AlertCircle } from 'lucide-react';
import { CollapsibleSection } from '../common/CollapsibleSection';

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
  return (window.electron?.fusion?.archives as ArchivesApi | undefined) ?? null;
}

export const ArchivesConfigSection: React.FC = () => {
  const { t } = useTranslation();
  const [europeanaConfigured, setEuropeanaConfigured] = useState(false);
  const [europeanaInput, setEuropeanaInput] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    const a = api();
    if (!a) {
      setError(t('archives.errors.noFusionApi'));
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
      setError(res.error ?? t('archives.errors.saveFailed'));
      return;
    }
    setEuropeanaInput('');
    setRevealed(false);
    await refresh();
    setSavedNotice(t('archives.notice.saved', { name: t('archives.europeana.name') }));
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
      setError(res.error ?? t('archives.errors.deleteFailed'));
      return;
    }
    await refresh();
    setSavedNotice(t('archives.notice.deleted', { name: t('archives.europeana.name') }));
    window.setTimeout(() => setSavedNotice(null), 3000);
  };

  return (
    <CollapsibleSection title={t('archives.title')} defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
      <p className="config-hint">{t('archives.hint')}</p>

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
            <strong style={{ fontSize: 13 }}>{t('archives.europeana.name')}</strong>{' '}
            <span style={{ fontSize: 11, opacity: 0.7 }}>
              {t('archives.europeana.description')}
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
                <Check size={12} /> {t('archives.status.configured')}
              </>
            ) : (
              <>{t('archives.status.notConfigured')}</>
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
                ? t('archives.input.replacePlaceholder')
                : t('archives.europeana.keyPlaceholder')
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
            aria-label={revealed ? t('archives.buttons.hideKeyAria') : t('archives.buttons.showKeyAria')}
            title={revealed ? t('archives.buttons.hideKey') : t('archives.buttons.showKey')}
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
            {busy ? '…' : t('archives.buttons.save')}
          </button>
          {europeanaConfigured && (
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => void handleDelete()}
              disabled={busy}
              style={{ color: 'var(--color-danger)' }}
            >
              {t('archives.buttons.delete')}
            </button>
          )}
        </div>

        <p style={{ fontSize: 11, marginTop: 8, opacity: 0.75 }}>
          {t('archives.europeana.mcpHint')}
        </p>
      </div>

      {savedNotice && (
        <p style={{ color: 'var(--color-accent)', fontSize: 12 }}>
          {savedNotice}
        </p>
      )}
        </div>
      </div>
    </CollapsibleSection>
  );
};
