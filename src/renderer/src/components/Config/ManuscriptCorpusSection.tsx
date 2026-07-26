/**
 * Corpus manuscrit — état de l'index et commande de reconstruction.
 *
 * Le service, les canaux IPC et le réglage `rag.indexManuscript` existaient
 * tous, mais rien dans l'interface ne les atteignait : l'historien payait
 * une indexation à chaque sauvegarde sans pouvoir la voir, la reconstruire
 * ni l'arrêter. C'est le dernier trou fonctionnel du cycle rc.4.
 *
 * Le panneau reste délibérément sobre : trois nombres, une date, un bouton.
 * Ce que l'auteur a besoin de savoir, c'est si l'index reflète ce qu'il
 * vient d'écrire — d'où la date, sans laquelle deux compteurs ne disent
 * rien.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, BookMarked } from 'lucide-react';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { useProjectStore } from '../../stores/projectStore';

interface ManuscriptStats {
  chapterCount: number;
  chunkCount: number;
  lastIndexedAt: string | null;
}

interface IndexReport {
  indexed: number;
  unchanged: number;
  removed: number;
  chunks: number;
  failures: Array<{ relativePath: string; reason: string }>;
  durationMs: number;
}

interface ManuscriptApi {
  index(): Promise<{
    success: boolean;
    report?: IndexReport | null;
    reason?: string;
    error?: string;
  }>;
  stats(): Promise<{
    success: boolean;
    stats?: ManuscriptStats | null;
    error?: string;
  }>;
}

function manuscriptApi(): ManuscriptApi | null {
  return (window.electron as { manuscript?: ManuscriptApi })?.manuscript ?? null;
}

interface Props {
  /** `rag.indexManuscript` — le corpus est-il actif ? */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

export const ManuscriptCorpusSection: React.FC<Props> = ({
  enabled,
  onEnabledChange,
}) => {
  const { t, i18n } = useTranslation('common');
  const currentProject = useProjectStore((s) => s.currentProject);
  const [stats, setStats] = useState<ManuscriptStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = manuscriptApi();
    if (!api || !currentProject) {
      setStats(null);
      return;
    }
    try {
      const res = await api.stats();
      setStats(res.success ? (res.stats ?? null) : null);
      if (!res.success && res.error !== 'no_project') {
        setError(t('manuscriptCorpus.statsError'));
      }
    } catch {
      setStats(null);
    }
  }, [currentProject, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reindex = async () => {
    const api = manuscriptApi();
    if (!api) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.index();
      if (!res.success) {
        setError(t('manuscriptCorpus.indexError'));
      } else if (res.reason === 'embedding_provider_unavailable') {
        // Ollama éteint : l'index reste en l'état, ce n'est pas une panne.
        setError(t('manuscriptCorpus.noProvider'));
      } else if (res.report) {
        const r = res.report;
        setNotice(
          t('manuscriptCorpus.indexDone', {
            indexed: r.indexed,
            unchanged: r.unchanged,
          })
        );
        if (r.failures.length > 0) {
          setError(t('manuscriptCorpus.partialFailure', { count: r.failures.length }));
        }
      }
      await refresh();
    } catch {
      setError(t('manuscriptCorpus.indexError'));
    } finally {
      setBusy(false);
    }
  };

  const lastIndexed = stats?.lastIndexedAt
    ? new Date(stats.lastIndexedAt).toLocaleString(i18n.language)
    : null;

  return (
    <CollapsibleSection title={t('manuscriptCorpus.title')} defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
          <p className="config-hint">{t('manuscriptCorpus.hint')}</p>

          <div className="config-field">
            <label className="config-label">
              {t('manuscriptCorpus.enabled')}
              <span className="config-help">{t('manuscriptCorpus.enabledHelp')}</span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => onEnabledChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>
                {t(enabled ? 'manuscriptCorpus.on' : 'manuscriptCorpus.off')}
              </span>
            </div>
          </div>

          {!currentProject && (
            <p className="config-hint">{t('manuscriptCorpus.noProject')}</p>
          )}

          {currentProject && (
            <div className="config-field">
              <label className="config-label">{t('manuscriptCorpus.state')}</label>
              {stats && stats.chapterCount > 0 ? (
                <div className="config-description">
                  {t('manuscriptCorpus.chapters', { count: stats.chapterCount })}
                  {' · '}
                  {t('manuscriptCorpus.chunks', { count: stats.chunkCount })}
                  {lastIndexed && (
                    <>
                      <br />
                      <small>
                        {t('manuscriptCorpus.lastIndexed', { when: lastIndexed })}
                      </small>
                    </>
                  )}
                </div>
              ) : (
                <div className="config-description">
                  {t('manuscriptCorpus.empty')}
                </div>
              )}

              <button
                type="button"
                className="config-btn-small"
                onClick={() => void reindex()}
                disabled={busy || !enabled}
                title={t('manuscriptCorpus.reindexTitle')}
                aria-label={t('manuscriptCorpus.reindexTitle')}
                style={{ marginTop: 8 }}
              >
                <RefreshCw size={13} />{' '}
                {busy ? t('manuscriptCorpus.indexing') : t('manuscriptCorpus.reindex')}
              </button>
            </div>
          )}

          {notice && (
            <p style={{ color: 'var(--color-accent)', fontSize: 12 }}>
              <BookMarked size={12} /> {notice}
            </p>
          )}
          {error && (
            <p style={{ color: 'var(--color-danger)', fontSize: 12 }}>{error}</p>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
};
