import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Save } from 'lucide-react';

interface HintsApi {
  read(): Promise<{
    success: boolean;
    hints?: { present: boolean; raw: string; normalized: string; sourcePath: string };
    error?: string;
  }>;
  write(markdown: string): Promise<{
    success: boolean;
    hints?: { present: boolean; raw: string; normalized: string; sourcePath: string };
    error?: string;
  }>;
}

function api(): HintsApi | null {
  return (window.electron?.fusion?.hints as HintsApi | undefined) ?? null;
}

export const WorkspaceHintsSection: React.FC = () => {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [sourcePath, setSourcePath] = useState<string>('.cliodeck/v2/hints.md');
  const [status, setStatus] = useState<
    { kind: 'idle' } | { kind: 'saving' } | { kind: 'ok' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const h = api();
    if (!h) {
      setStatus({ kind: 'error', message: t('hints.errors.noFusionApi') });
      return;
    }
    void h.read().then((res) => {
      if (res.success && res.hints) {
        setValue(res.hints.raw);
        setSourcePath(res.hints.sourcePath);
      } else if (res.error === 'no_project') {
        setStatus({ kind: 'error', message: t('hints.errors.noProject') });
      } else if (res.error) {
        setStatus({ kind: 'error', message: res.error });
      }
      setLoaded(true);
    });
  }, [t]);

  const save = useCallback(async () => {
    const h = api();
    if (!h) return;
    setStatus({ kind: 'saving' });
    const res = await h.write(value);
    if (res.success) {
      setStatus({ kind: 'ok' });
      setTimeout(() => setStatus({ kind: 'idle' }), 1500);
    } else {
      setStatus({ kind: 'error', message: res.error ?? t('hints.errors.saveFailed') });
    }
  }, [value, t]);

  return (
    <section className="config-section">
      <h3 className="config-section-title">
        <FileText size={16} /> {t('hints.title')} (<code>.cliohints</code>)
      </h3>
      <p className="config-hint">{t('hints.hint')}</p>
      <p className="config-hint" style={{ fontSize: 11, opacity: 0.7 }}>
        {t('hints.filePath')} <code>{sourcePath}</code>
      </p>
      <textarea
        className="config-textarea"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={!loaded || status.kind === 'saving'}
        rows={10}
        placeholder={t('hints.placeholder')}
        style={{
          width: '100%',
          fontFamily: 'var(--mono-font, ui-monospace, monospace)',
          fontSize: 12,
          padding: 8,
          background: 'var(--bg-app)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-color)',
          borderRadius: 4,
          resize: 'vertical',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
        <button
          type="button"
          className="toolbar-btn"
          onClick={save}
          disabled={!loaded || status.kind === 'saving'}
          title={t('hints.buttons.saveTitle')}
        >
          <Save size={16} strokeWidth={1} /> {t('hints.buttons.save')}
        </button>
        {status.kind === 'ok' && (
          <span style={{ color: 'var(--color-accent)' }}>{t('hints.status.saved')}</span>
        )}
        {status.kind === 'saving' && <span>…</span>}
        {status.kind === 'error' && (
          <span style={{ color: 'var(--color-danger)' }}>{status.message}</span>
        )}
      </div>
    </section>
  );
};
