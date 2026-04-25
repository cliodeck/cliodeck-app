import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, FolderOpen, Link2Off, Play } from 'lucide-react';

interface VaultStatus {
  indexed: boolean;
  dbPath: string;
  vaultPath: string | null;
}

interface VaultApi {
  status(): Promise<{
    success: boolean;
    indexed?: boolean;
    dbPath?: string;
    vaultPath?: string | null;
    error?: string;
  }>;
  setPath(
    path: string
  ): Promise<{ success: boolean; vaultPath?: string; error?: string }>;
  unlink(): Promise<{ success: boolean; error?: string }>;
  index(opts?: {
    force?: boolean;
  }): Promise<{
    success: boolean;
    indexed?: number;
    skipped?: number;
    failed?: number;
    vaultName?: string;
    error?: string;
  }>;
  onProgress(
    cb: (p: { stage: string; processed: number; total: number }) => void
  ): () => void;
}

function vaultApi(): VaultApi | null {
  return (window.electron?.fusion?.vault as VaultApi | undefined) ?? null;
}

type DialogApi = {
  openFile(opts: {
    properties?: string[];
    title?: string;
  }): Promise<{ canceled: boolean; filePaths?: string[] }>;
};

function dialogApi(): DialogApi | null {
  return (window.electron?.dialog as DialogApi | undefined) ?? null;
}

export const VaultConfigSection: React.FC = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<
    { stage: string; processed: number; total: number } | null
  >(null);
  const [lastReport, setLastReport] = useState<
    { indexed: number; skipped: number; failed: number; vaultName?: string } | null
  >(null);

  const refresh = useCallback(async () => {
    const api = vaultApi();
    if (!api) {
      setError(t('vault.errors.noFusionApi'));
      return;
    }
    const res = await api.status();
    if (res.success) {
      setStatus({
        indexed: !!res.indexed,
        dbPath: res.dbPath ?? '',
        vaultPath: res.vaultPath ?? null,
      });
      setError(null);
    } else if (res.error === 'no_project') {
      setError(t('vault.errors.noProject'));
    } else {
      setError(res.error ?? t('vault.errors.statusFailed'));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    const api = vaultApi();
    const unsub = api?.onProgress((p) => setProgress(p));
    return () => {
      unsub?.();
    };
  }, [refresh]);

  const pickVault = useCallback(async () => {
    const dlg = dialogApi();
    if (!dlg) return;
    const res = await dlg.openFile({
      properties: ['openDirectory'],
      title: t('vault.dialog.pickTitle'),
    });
    if (res.canceled || !res.filePaths?.length) return;
    const api = vaultApi();
    if (!api) return;
    setBusy(true);
    try {
      const setRes = await api.setPath(res.filePaths[0]);
      if (!setRes.success) {
        setError(setRes.error ?? t('vault.errors.configRefused'));
      } else {
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }, [refresh, t]);

  const runIndex = useCallback(
    async (force: boolean) => {
      const api = vaultApi();
      if (!api) return;
      setBusy(true);
      setProgress(null);
      setLastReport(null);
      try {
        const res = await api.index({ force });
        if (res.success) {
          setLastReport({
            indexed: res.indexed ?? 0,
            skipped: res.skipped ?? 0,
            failed: res.failed ?? 0,
            vaultName: res.vaultName,
          });
          await refresh();
        } else {
          setError(res.error ?? t('vault.errors.indexFailed'));
        }
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [refresh, t]
  );

  const unlink = useCallback(async () => {
    const api = vaultApi();
    if (!api) return;
    setBusy(true);
    try {
      await api.unlink();
      setLastReport(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <section className="config-section">
      <h3 className="config-section-title">
        <Database size={16} /> {t('vault.title')}
      </h3>
      <p className="config-hint">{t('vault.hint')}</p>

      {error && (
        <p style={{ color: 'var(--color-danger)', fontSize: 12 }}>{error}</p>
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
        <div style={{ fontSize: 12 }}>
          <strong>{t('vault.labels.path')}</strong>{' '}
          {status?.vaultPath ? (
            <code>{status.vaultPath}</code>
          ) : (
            <em style={{ opacity: 0.7 }}>{t('vault.labels.noVaultLinked')}</em>
          )}
        </div>
        <div style={{ fontSize: 12, marginTop: 4 }}>
          <strong>{t('vault.labels.index')}</strong>{' '}
          {status?.indexed ? (
            <span>
              {t('vault.labels.ready')} · <code>{status.dbPath}</code>
            </span>
          ) : (
            <em style={{ opacity: 0.7 }}>{t('vault.labels.notIndexed')}</em>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => void pickVault()}
          disabled={busy}
        >
          <FolderOpen size={14} strokeWidth={1} />{' '}
          {status?.vaultPath
            ? t('vault.buttons.changeVault')
            : t('vault.buttons.linkVault')}
        </button>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => void runIndex(false)}
          disabled={busy || !status?.vaultPath}
          title={t('vault.buttons.indexTitle')}
        >
          <Play size={14} strokeWidth={1} /> {t('vault.buttons.index')}
        </button>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => void runIndex(true)}
          disabled={busy || !status?.vaultPath}
          title={t('vault.buttons.reindexTitle')}
        >
          <Play size={14} strokeWidth={1} /> {t('vault.buttons.reindex')}
        </button>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => void unlink()}
          disabled={busy || !status?.vaultPath}
          title={t('vault.buttons.unlinkTitle')}
        >
          <Link2Off size={14} strokeWidth={1} /> {t('vault.buttons.unlink')}
        </button>
      </div>

      {progress && (
        <p style={{ marginTop: 8, fontSize: 12 }}>
          {progress.stage} — {progress.processed}/{progress.total}
        </p>
      )}

      {lastReport && (
        <p style={{ marginTop: 8, fontSize: 12 }}>
          ✓ {t('vault.report.indexed')} : <strong>{lastReport.indexed}</strong> ·{' '}
          {t('vault.report.skipped')} : {lastReport.skipped} ·{' '}
          {t('vault.report.failed')} : {lastReport.failed}
          {lastReport.vaultName ? ` · ${lastReport.vaultName}` : ''}
        </p>
      )}
    </section>
  );
};
