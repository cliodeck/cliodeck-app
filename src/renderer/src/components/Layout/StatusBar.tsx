import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/projectStore';
import { useEditorStore } from '../../stores/editorStore';
import { currentRelativePath } from '../../stores/manuscriptStore';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { usePrimarySourcesStore } from '../../stores/primarySourcesStore';
import { useUsageJournalStore } from '../../stores/usageJournalStore';
import { useTropyReindexStatus } from '../../stores/tropyReindexStore';
import { describeReindexStatus, reindexStatusLabel } from '../PrimarySources/reindex-status';
import { usePdfIndexRebuildDue } from '../../stores/pdfIndexStore';
import { useTropyReembedProposal } from '../../stores/tropyReembedStore';
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
  const { t, i18n } = useTranslation();
  const { currentProject } = useProjectStore();
  const [mcpClients, setMcpClients] = useState<MCPClientSummary[]>([]);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);

  // État de sauvegarde du document courant (audit item 20) : sur un
  // manuscrit long, ne pas savoir si son texte est sur le disque est
  // anxiogène. `isDirty` bascule à la frappe, `lastSavedAt` à l'écriture.
  const isDirty = useEditorStore((s) => s.isDirty);
  const filePath = useEditorStore((s) => s.filePath);
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);
  const bufferDetached = useEditorStore((s) => s.bufferDetached);
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

  // Réindexation complète des sources primaires (H7) : des heures possibles,
  // à voir même le panneau Sources primaires fermé.
  const reindex = useTropyReindexStatus();

  // Index des PDF à reconstruire (J8) : proposé à la réouverture, dans le panneau
  // Bibliographie, que l'écran ne montre pas forcément.
  const pdfIndex = usePdfIndexRebuildDue();

  // Sources primaires à réindexer après un changement de modèle d'embeddings (Q29) : proposé dans
  // le panneau Sources primaires, que l'écran ne montre pas forcément.
  const tropyReembed = useTropyReembedProposal();

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

    // Une réponse du projet quitté, arrivée après la bascule, n'a rien à dire du suivant.
    let left = false;

    // Les réponses sont étalées (`{ success, clients }`, `{ success, vaultPath, noteCount }`) : la
    // barre lisait `data.clients` et `data.noteCount`, et ses indicateurs ne s'affichaient jamais
    // (S17-1-10).
    const refresh = async () => {
      try {
        const mcpResult = await window.electron.fusion?.mcp?.list();
        if (left) return;
        if (mcpResult?.success && Array.isArray(mcpResult.clients)) {
          setMcpClients(
            mcpResult.clients.map((c: { name: string; state: string }) => ({
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
        if (left) return;
        // Lié : un chemin de vault. `brain.db` existe dans tout projet, il ne dit rien du vault.
        if (vaultResult?.success && vaultResult.vaultPath) {
          setVaultStatus({
            connected: true,
            noteCount: vaultResult.noteCount,
          });
        } else {
          setVaultStatus(null);
        }
      } catch {
        if (!left) setVaultStatus(null);
      }
    };

    refresh();

    // Subscribe to MCP events for live updates
    const unsub = window.electron.fusion?.mcp?.onEvent?.((event: unknown) => {
      const payload = event as { kind?: string } | null;
      if (payload?.kind === 'state_changed') refresh();
    });

    // Also refresh periodically (30s) for vault changes
    const timer = setInterval(refresh, 30_000);

    return () => {
      left = true;
      clearInterval(timer);
      unsub?.();
    };
  }, [currentProject, loadUsageToday]);

  if (!currentProject) return null;

  // Le fichier que montre l'éditeur (G7) : après « Enregistrer sous », l'éditeur reste sur
  // le nouveau fichier, et rien à l'écran ne le nommait. Lu sur le magasin, jamais sur le
  // disque ; rien pendant un changement de projet, où l'éditeur n'est sur aucun document.
  // Un chemin du projet en deux parties, le dossier et le nom (séparateur compris) : quand la
  // place manque, le dossier cède avant le nom, qui est l'information cherchée.
  const relativePath = currentRelativePath();
  const nameAt =
    relativePath === null
      ? 0
      : Math.max(relativePath.lastIndexOf('/'), relativePath.lastIndexOf('\\'), 0);
  const openFile = bufferDetached
    ? null
    : filePath === null
      ? { dir: '', name: t('statusBar.untitled'), title: undefined }
      : relativePath !== null
        ? { dir: relativePath.slice(0, nameAt), name: relativePath.slice(nameAt), title: filePath }
        : {
            dir: '',
            name: filePath.split(/[\\/]/).pop() || filePath,
            title: t('statusBar.fileOutsideProjectTooltip', { path: filePath }),
          };

  const readyCount = mcpClients.filter((c) => c.state === 'ready').length;
  const failedCount = mcpClients.filter((c) => c.state === 'failed').length;

  return (
    <div className="status-bar" role="status" aria-live="polite">
      <div className="status-bar__section status-bar__section--left">
        <span className="status-bar__item status-bar__item--project" title={currentProject.name}>
          {currentProject.name}
        </span>
        {openFile && (
          <span className="status-bar__item status-bar__item--file" title={openFile.title}>
            {openFile.dir && <span className="status-bar__file-dir">{openFile.dir}</span>}
            <span className="status-bar__file-name">{openFile.name}</span>
          </span>
        )}
      </div>

      <div className="status-bar__section status-bar__section--right">
        {/* Save state of the current document. Un tampon sans titre modifié compte
            aussi : son texte n'est nulle part, et rien d'autre ne le dit. Un document
            tout juste ouvert n'a rien à écrire : « Non modifié », pas « Non enregistré » (D6). */}
        {(filePath || isDirty) && (
          <span
            className={`status-bar__item ${isDirty ? 'status-bar__item--warning' : ''}`}
            title={
              isDirty
                ? t('statusBar.unsavedTooltip')
                : lastSavedAt
                  ? t('statusBar.savedTooltip', {
                      time: new Date(lastSavedAt).toLocaleTimeString(),
                    })
                  : t('statusBar.notModifiedTooltip')
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
                : t('statusBar.notModified')}
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

        {/* Réindexation complète des sources primaires : le détail en infobulle */}
        {reindex.phase !== 'idle' && (
          <span
            className={`status-bar__item ${reindex.phase === 'stopped' ? 'status-bar__item--warning' : 'status-bar__item--active'}`}
            title={describeReindexStatus(t, reindex, i18n.language) ?? undefined}
          >
            {((reindex.phase === 'running' && !reindex.waitingForSync) || reindex.phase === 'rebuilding-index') && (
              <span className="status-bar__spinner" />
            )}
            {reindexStatusLabel(t, reindex)}
          </span>
        )}

        {/* Index des PDF à reconstruire : ouvre le panneau Bibliographie, où le bandeau le propose */}
        {pdfIndex.due && (
          <button
            type="button"
            className="status-bar__item status-bar__item--warning status-bar__button"
            title={t('pdfIndexRebuild.statusTooltip')}
            onClick={() => window.dispatchEvent(new CustomEvent('switch-panel', { detail: 'bibliography' }))}
          >
            {t('pdfIndexRebuild.status')}
          </button>
        )}

        {/* Sources primaires à réindexer : ouvre le panneau, où le bandeau le propose */}
        {tropyReembed.proposal && (
          <button
            type="button"
            className="status-bar__item status-bar__item--warning status-bar__button"
            title={t('primarySources.reembed.statusTooltip')}
            onClick={() => window.dispatchEvent(new CustomEvent('switch-panel', { detail: 'primary-sources' }))}
          >
            {t('primarySources.reembed.status')}
          </button>
        )}

        {/* MCP clients */}
        {mcpClients.length > 0 && (
          <span
            className={`status-bar__item ${failedCount > 0 ? 'status-bar__item--warning' : ''}`}
            title={t('statusBar.mcpTooltip', {
              // L'accord se fait sur les serveurs prêts : « 1/2 prêt », « 2/2 prêts ».
              count: readyCount,
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
