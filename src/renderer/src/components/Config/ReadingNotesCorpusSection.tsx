/**
 * Corpus « notes de lecture » — réglages, état de l'index, reconstruction.
 *
 * Même facture que `ManuscriptCorpusSection`, plus un réglage qui lui est
 * propre : l'envoi à un fournisseur distant. Les notes de lecture sont le
 * travail personnel de l'historien ; elles ne partent vers un modèle en
 * ligne que s'il coche la case, et la case est décochée par défaut.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, NotebookPen } from 'lucide-react';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { useProjectStore } from '../../stores/projectStore';

interface ReadingNotesStats {
  noteCount: number;
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

interface IndexResponse {
  success: boolean;
  report?: IndexReport | null;
  reason?: string;
  error?: string;
}

interface ReadingNotesCorpusApi {
  index(): Promise<IndexResponse>;
  reindexAll(): Promise<IndexResponse>;
  stats(): Promise<{ success: boolean; stats?: ReadingNotesStats | null; error?: string }>;
}

function corpusApi(): ReadingNotesCorpusApi | null {
  return (window.electron as { readingNotesCorpus?: ReadingNotesCorpusApi })?.readingNotesCorpus ?? null;
}

interface Props {
  /** `rag.indexReadingNotes` — le corpus est-il actif ? */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** `rag.readingNotesCloudConsent` — envoi autorisé à un fournisseur distant ? */
  cloudConsent: boolean;
  onCloudConsentChange: (consent: boolean) => void;
}

export const ReadingNotesCorpusSection: React.FC<Props> = ({
  enabled,
  onEnabledChange,
  cloudConsent,
  onCloudConsentChange,
}) => {
  const { t, i18n } = useTranslation('common');
  const currentProject = useProjectStore((s) => s.currentProject);
  const [stats, setStats] = useState<ReadingNotesStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = corpusApi();
    if (!api || !currentProject) {
      setStats(null);
      return;
    }
    try {
      const res = await api.stats();
      setStats(res.success ? (res.stats ?? null) : null);
      if (!res.success && res.error !== 'no_project') {
        setError(t('readingNotesCorpus.statsError'));
      }
    } catch {
      setStats(null);
    }
  }, [currentProject, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reindex = async () => {
    const api = corpusApi();
    if (!api) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.reindexAll();
      if (!res.success) {
        setError(t('readingNotesCorpus.indexError'));
      } else if (res.reason === 'embedding_provider_unavailable') {
        setError(t('readingNotesCorpus.noProvider'));
      } else if (res.report) {
        setNotice(t('readingNotesCorpus.indexDone', { count: res.report.indexed }));
        if (res.report.failures.length > 0) {
          setError(t('readingNotesCorpus.partialFailure', { count: res.report.failures.length }));
        }
      }
      await refresh();
    } catch {
      setError(t('readingNotesCorpus.indexError'));
    } finally {
      setBusy(false);
    }
  };

  const lastIndexed = stats?.lastIndexedAt
    ? new Date(stats.lastIndexedAt).toLocaleString(i18n.language)
    : null;

  return (
    <CollapsibleSection title={t('readingNotesCorpus.title')} defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
          <p className="config-hint">{t('readingNotesCorpus.hint')}</p>

          <div className="config-field">
            <label className="config-label">
              {t('readingNotesCorpus.enabled')}
              <span className="config-help">{t('readingNotesCorpus.enabledHelp')}</span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => onEnabledChange(e.target.checked)}
                className="config-checkbox"
                data-testid="reading-notes-corpus-enabled"
              />
              <span>{t(enabled ? 'readingNotesCorpus.on' : 'readingNotesCorpus.off')}</span>
            </div>
          </div>

          <div className="config-field">
            <label className="config-label">
              {t('readingNotesCorpus.cloudConsent')}
              <span className="config-help">{t('readingNotesCorpus.cloudConsentHelp')}</span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={cloudConsent}
                disabled={!enabled}
                onChange={(e) => onCloudConsentChange(e.target.checked)}
                className="config-checkbox"
                data-testid="reading-notes-cloud-consent"
              />
              <span>
                {t(cloudConsent ? 'readingNotesCorpus.cloudAllowed' : 'readingNotesCorpus.cloudLocalOnly')}
              </span>
            </div>
          </div>

          {!currentProject && <p className="config-hint">{t('readingNotesCorpus.noProject')}</p>}

          {currentProject && (
            <div className="config-field">
              <label className="config-label">{t('readingNotesCorpus.state')}</label>
              {stats && stats.noteCount > 0 ? (
                <div className="config-description">
                  {t('readingNotesCorpus.notes', { count: stats.noteCount })}
                  {' · '}
                  {t('readingNotesCorpus.chunks', { count: stats.chunkCount })}
                  {lastIndexed && (
                    <>
                      <br />
                      <small>{t('readingNotesCorpus.lastIndexed', { when: lastIndexed })}</small>
                    </>
                  )}
                </div>
              ) : (
                <div className="config-description">{t('readingNotesCorpus.empty')}</div>
              )}

              <button
                type="button"
                className="config-btn-small"
                onClick={() => void reindex()}
                disabled={busy || !enabled}
                title={t('readingNotesCorpus.reindexTitle')}
                aria-label={t('readingNotesCorpus.reindexTitle')}
                style={{ marginTop: 8 }}
              >
                <RefreshCw size={13} />{' '}
                {busy ? t('readingNotesCorpus.indexing') : t('readingNotesCorpus.reindex')}
              </button>
            </div>
          )}

          {notice && (
            <p style={{ color: 'var(--color-accent)', fontSize: 12 }}>
              <NotebookPen size={12} /> {notice}
            </p>
          )}
          {error && <p style={{ color: 'var(--color-danger)', fontSize: 12 }}>{error}</p>}
        </div>
      </div>
    </CollapsibleSection>
  );
};
