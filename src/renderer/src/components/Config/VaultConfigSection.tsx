import React, { useCallback, useEffect, useState } from 'react';
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
  return (
    (window as unknown as { electron?: { fusion?: { vault?: VaultApi } } })
      .electron?.fusion?.vault ?? null
  );
}

type DialogApi = {
  openFile(opts: {
    properties?: string[];
    title?: string;
  }): Promise<{ canceled: boolean; filePaths?: string[] }>;
};

function dialogApi(): DialogApi | null {
  return (
    (window as unknown as { electron?: { dialog?: DialogApi } }).electron
      ?.dialog ?? null
  );
}

export const VaultConfigSection: React.FC = () => {
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
      setError('Fusion API non exposée par le preload.');
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
      setError('Ouvrez un projet pour configurer le vault.');
    } else {
      setError(res.error ?? 'Impossible de lire le statut du vault.');
    }
  }, []);

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
      title: 'Sélectionner le dossier du vault Obsidian',
    });
    if (res.canceled || !res.filePaths?.length) return;
    const api = vaultApi();
    if (!api) return;
    setBusy(true);
    try {
      const setRes = await api.setPath(res.filePaths[0]);
      if (!setRes.success) {
        setError(setRes.error ?? 'Configuration refusée.');
      } else {
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }, [refresh]);

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
          setError(res.error ?? 'Indexation échouée.');
        }
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [refresh]
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
        <Database size={16} /> Vault Obsidian
      </h3>
      <p className="config-hint">
        Lie un vault Obsidian (dossier de notes Markdown) pour que le chat
        Brainstorm puisse citer tes notes en plus de ta bibliographie. Les
        notes sont indexées localement dans <code>.cliodeck/v2/obsidian-vectors.db</code>.
      </p>

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
          <strong>Chemin :</strong>{' '}
          {status?.vaultPath ? (
            <code>{status.vaultPath}</code>
          ) : (
            <em style={{ opacity: 0.7 }}>aucun vault lié</em>
          )}
        </div>
        <div style={{ fontSize: 12, marginTop: 4 }}>
          <strong>Index :</strong>{' '}
          {status?.indexed ? (
            <span>prêt · <code>{status.dbPath}</code></span>
          ) : (
            <em style={{ opacity: 0.7 }}>non indexé</em>
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
          {status?.vaultPath ? 'Changer de vault…' : 'Lier un vault…'}
        </button>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => void runIndex(false)}
          disabled={busy || !status?.vaultPath}
          title="Indexe les notes nouvelles ou modifiées"
        >
          <Play size={14} strokeWidth={1} /> Indexer
        </button>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => void runIndex(true)}
          disabled={busy || !status?.vaultPath}
          title="Force le réindexation complète"
        >
          <Play size={14} strokeWidth={1} /> Réindexer (force)
        </button>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => void unlink()}
          disabled={busy || !status?.vaultPath}
          title="Détache le vault et supprime l'index local"
        >
          <Link2Off size={14} strokeWidth={1} /> Détacher
        </button>
      </div>

      {progress && (
        <p style={{ marginTop: 8, fontSize: 12 }}>
          {progress.stage} — {progress.processed}/{progress.total}
        </p>
      )}

      {lastReport && (
        <p style={{ marginTop: 8, fontSize: 12 }}>
          ✓ Indexé : <strong>{lastReport.indexed}</strong> · ignoré :{' '}
          {lastReport.skipped} · échecs : {lastReport.failed}
          {lastReport.vaultName ? ` · ${lastReport.vaultName}` : ''}
        </p>
      )}
    </section>
  );
};
