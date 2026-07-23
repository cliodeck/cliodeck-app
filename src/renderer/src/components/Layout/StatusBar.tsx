import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/projectStore';
import { useEditorStore } from '../../stores/editorStore';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { usePrimarySourcesStore } from '../../stores/primarySourcesStore';
import { useUsageJournalStore } from '../../stores/usageJournalStore';
import './StatusBar.css';

interface MCPClientSummary {
  name: string;
  state: string;
}

interface VaultStatus {
  connected: boolean;
  noteCount?: number;
}

export const StatusBar: React.FC = () => {
  const { t } = useTranslation();
  const { currentProject } = useProjectStore();
  const [mcpClients, setMcpClients] = useState<MCPClientSummary[]>([]);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);

  // État de sauvegarde du document courant (audit item 20) : sur un
  // manuscrit long, ne pas savoir si son texte est sur le disque est
  // anxiogène. `isDirty` bascule à la frappe, `lastSavedAt` à l'écriture.
  const isDirty = useEditorStore((s) => s.isDirty);
  const filePath = useEditorStore((s) => s.filePath);
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);
  // Re-rend chaque minute pour que « il y a 3 min » reste vrai sans
  // re-rendre à la frappe.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  // PDF indexing progress from bibliography store
  const batchIndexing = useBibliographyStore((s) => s.batchIndexing);

  // Tropy sync status from primary sources store
  const isSyncing = usePrimarySourcesStore((s) => s.isSyncing);
  const syncProgress = usePrimarySourcesStore((s) => s.syncProgress);

  // Usage journal: substantial sessions of the day not yet covered by a
  // decision. Shared store with the Cmd/Ctrl+J modal, so annotating there
  // updates the badge immediately.
  const uncoveredSessions = useUsageJournalStore(
    (s) => s.today?.summary.violations.length ?? 0
  );
  const loadUsageToday = useUsageJournalStore((s) => s.loadToday);

  useEffect(() => {
    if (!currentProject) {
      setMcpClients([]);
      setVaultStatus(null);
      return;
    }

    const refresh = async () => {
      try {
        const mcpResult = await window.electron.fusion?.mcp?.list();
        if (mcpResult?.success && mcpResult.data?.clients) {
          setMcpClients(
            mcpResult.data.clients.map((c: { name: string; state: string }) => ({
              name: c.name,
              state: c.state,
            }))
          );
        }
      } catch {
        // MCP not available
      }

      void loadUsageToday();

      try {
        const vaultResult = await window.electron.fusion?.vault?.status();
        if (vaultResult?.success && vaultResult.data) {
          setVaultStatus({
            connected: true,
            noteCount: vaultResult.data.noteCount,
          });
        } else {
          setVaultStatus(null);
        }
      } catch {
        setVaultStatus(null);
      }
    };

    refresh();

    // Subscribe to MCP events for live updates
    const unsub = window.electron.fusion?.mcp?.onEvent?.((event: unknown) => {
      const payload = event as { type?: string } | null;
      if (payload?.type === 'stateChanged') refresh();
    });

    // Also refresh periodically (30s) for vault changes
    const timer = setInterval(refresh, 30_000);

    return () => {
      clearInterval(timer);
      unsub?.();
    };
  }, [currentProject, loadUsageToday]);

  if (!currentProject) return null;

  const readyCount = mcpClients.filter((c) => c.state === 'ready').length;
  const failedCount = mcpClients.filter((c) => c.state === 'failed').length;

  return (
    <div className="status-bar" role="status" aria-live="polite">
      <div className="status-bar__section">
        <span className="status-bar__item" title={currentProject.name}>
          {currentProject.name}
        </span>
      </div>

      <div className="status-bar__section status-bar__section--right">
        {/* Save state of the current document */}
        {filePath && (
          <span
            className={`status-bar__item ${isDirty ? 'status-bar__item--warning' : ''}`}
            title={
              isDirty
                ? t('statusBar.unsavedTooltip')
                : lastSavedAt
                  ? t('statusBar.savedTooltip', {
                      time: new Date(lastSavedAt).toLocaleTimeString(),
                    })
                  : t('statusBar.notSavedYetTooltip')
            }
          >
            {isDirty
              ? t('statusBar.unsaved')
              : lastSavedAt
                ? t('statusBar.savedAt', {
                    time: new Date(lastSavedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                  })
                : t('statusBar.notSavedYet')}
          </span>
        )}

        {/* PDF indexing in progress */}
        {batchIndexing.isIndexing && (
          <span
            className="status-bar__item status-bar__item--active"
            title={t('statusBar.indexingTooltip', {
              current: batchIndexing.current,
              total: batchIndexing.total,
              defaultValue: `Indexing: ${batchIndexing.current}/${batchIndexing.total}`,
            })}
          >
            <span className="status-bar__spinner" />
            {t('statusBar.indexing', { defaultValue: 'Indexing' })} {batchIndexing.current}/{batchIndexing.total}
          </span>
        )}

        {/* Tropy sync in progress */}
        {isSyncing && (
          <span
            className="status-bar__item status-bar__item--active"
            title={syncProgress
              ? t('statusBar.syncTooltip', {
                  phase: syncProgress.phase,
                  current: syncProgress.current,
                  total: syncProgress.total,
                  defaultValue: `Sync: ${syncProgress.phase} ${syncProgress.current}/${syncProgress.total}`,
                })
              : t('statusBar.syncing', { defaultValue: 'Syncing...' })
            }
          >
            <span className="status-bar__spinner" />
            {t('statusBar.syncing', { defaultValue: 'Sync' })}{' '}
            {syncProgress ? `${syncProgress.current}/${syncProgress.total}` : '...'}
          </span>
        )}

        {/* MCP clients */}
        {mcpClients.length > 0 && (
          <span
            className={`status-bar__item ${failedCount > 0 ? 'status-bar__item--warning' : ''}`}
            title={t('statusBar.mcpTooltip', {
              ready: readyCount,
              total: mcpClients.length,
              defaultValue: `MCP: ${readyCount}/${mcpClients.length} ready`,
            })}
          >
            MCP {readyCount}/{mcpClients.length}
            {failedCount > 0 && <span className="status-bar__dot status-bar__dot--danger" />}
          </span>
        )}

        {/* Usage journal: sessions waiting for annotation (opens the Cmd/Ctrl+J modal) */}
        {uncoveredSessions > 0 && (
          <button
            type="button"
            className="status-bar__item status-bar__item--warning status-bar__button"
            title={t('statusBar.usageJournalTooltip')}
            onClick={() => window.dispatchEvent(new CustomEvent('show-usage-journal'))}
          >
            {t('statusBar.usageJournalBadge', { count: uncoveredSessions })}
          </button>
        )}

        {/* Vault status */}
        {vaultStatus && (
          <span className="status-bar__item" title={t('statusBar.vaultTooltip', {
            count: vaultStatus.noteCount ?? 0,
            defaultValue: `Vault: ${vaultStatus.noteCount ?? 0} notes`,
          })}>
            Vault {vaultStatus.noteCount ?? 0}
          </span>
        )}
      </div>
    </div>
  );
};
