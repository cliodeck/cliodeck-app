import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, HelpCircle, RefreshCw, KeyRound } from 'lucide-react';
import { HelpModal } from '../common/HelpModal';
import { useDialogStore } from '../../stores/dialogStore';
import './SecurityConfigSection.css';

type InspectorMode = 'warn' | 'audit' | 'block';
type Severity = 'low' | 'medium' | 'high';

interface SecurityEventRecord {
  kind: string;
  chunkId: string;
  at: string;
  severity?: Severity;
  pattern?: string;
  url?: string;
  detail?: string;
  mode?: InspectorMode;
  source?: { kind?: string; documentId?: string; chunkId?: string };
}

interface SecurityEventStatsRecord {
  total: number;
  byKind: Record<string, number>;
  bySeverity: Record<Severity, number>;
  firstAt?: string;
  lastAt?: string;
  recent: SecurityEventRecord[];
}

interface SecurityApi {
  getMode(): Promise<{ success: boolean; mode?: InspectorMode; error?: string }>;
  setMode(mode: InspectorMode): Promise<{
    success: boolean;
    mode?: InspectorMode;
    error?: string;
  }>;
  getEvents?(opts?: { recentLimit?: number }): Promise<{
    success: boolean;
    stats?: SecurityEventStatsRecord;
    error?: string;
  }>;
  revokeAllKeys?(): Promise<{
    success: boolean;
    keysDeleted?: number;
    error?: string;
  }>;
}

function api(): SecurityApi | null {
  return (window.electron?.fusion?.security as SecurityApi | undefined) ?? null;
}

/** Clé i18n du libellé d'un type d'événement. */
const KIND_KEYS: Record<string, string> = {
  suspicious_instruction: 'security.kinds.suspiciousInstruction',
  external_url: 'security.kinds.externalUrl',
  unusual_encoding: 'security.kinds.unusualEncoding',
  prompt_injection_blocked: 'security.kinds.injectionBlocked',
};

type Translate = (key: string, opts?: Record<string, unknown>) => string;

function formatRelative(isoAt: string, t: Translate, locale: string): string {
  const at = Date.parse(isoAt);
  if (!Number.isFinite(at)) return isoAt;
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return t('security.events.justNow');
  if (minutes < 60) return t('security.events.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('security.events.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('security.events.daysAgo', { count: days });
  // Au-delà d'un mois, une date absolue est plus parlante — dans la langue
  // de l'interface, pas en français en dur.
  return new Date(at).toLocaleDateString(locale);
}

const MODE_OPTIONS: Array<{ value: InspectorMode; key: string }> = [
  { value: 'warn', key: 'warn' },
  { value: 'audit', key: 'audit' },
  { value: 'block', key: 'block' },
];

export const SecurityConfigSection: React.FC = () => {
  const { t, i18n } = useTranslation('common');
  const [mode, setMode] = useState<InspectorMode>('warn');
  const [loaded, setLoaded] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [stats, setStats] = useState<SecurityEventStatsRecord | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const refreshStats = useCallback(async (): Promise<void> => {
    const s = api();
    if (!s?.getEvents) {
      setStatsError('API getEvents non disponible.');
      return;
    }
    setStatsLoading(true);
    try {
      const res = await s.getEvents({ recentLimit: 20 });
      if (res.success && res.stats) {
        setStats(res.stats);
        setStatsError(null);
      } else {
        setStatsError(res.error ?? 'Lecture des événements impossible.');
      }
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    const s = api();
    if (!s) {
      setError('API sécurité non exposée par le preload.');
      setLoaded(true);
      return;
    }
    void s.getMode().then((res) => {
      if (res.success && res.mode) setMode(res.mode);
      else if (res.error) setError(res.error);
      setLoaded(true);
    });
    void refreshStats();
  }, [refreshStats]);

  const handleChange = async (next: InspectorMode): Promise<void> => {
    const s = api();
    if (!s) return;
    setError(null);
    const previous = mode;
    setMode(next); // optimistic
    const res = await s.setMode(next);
    if (!res.success) {
      setMode(previous);
      setError(res.error ?? 'Impossible d’enregistrer le mode.');
      return;
    }
    setSavedNotice('Mode mis à jour pour ce projet.');
    window.setTimeout(() => setSavedNotice(null), 2500);
  };

  return (
    <section className="config-section">
      <h3 className="config-section-title">
        <Shield size={16} /> {t('security.inspection.title')}
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="security-help-trigger"
          aria-label={t('security.inspection.helpAria')}
          title={t('security.inspection.helpAria')}
        >
          <HelpCircle size={16} />
        </button>
      </h3>
      <p className="config-hint">{t('security.inspection.hint')}</p>

      {error && (
        <p style={{ color: 'var(--color-danger)', fontSize: 12 }}>{error}</p>
      )}

      <div
        role="radiogroup"
        aria-label={t('security.inspection.modeGroupAria')}
        className="security-mode-group"
      >
        {MODE_OPTIONS.map((opt) => {
          const id = `inspector-mode-${opt.value}`;
          const checked = mode === opt.value;
          return (
            <label
              key={opt.value}
              htmlFor={id}
              className={`security-mode-card${checked ? ' is-active' : ''}`}
            >
              <input
                type="radio"
                id={id}
                name="inspector-mode"
                value={opt.value}
                checked={checked}
                disabled={!loaded}
                onChange={() => void handleChange(opt.value)}
              />
              <span className="security-mode-label">
                {t(`security.modes.${opt.key}.label`)}
              </span>
              <span className="security-mode-blurb">
                {t(`security.modes.${opt.key}.blurb`)}
              </span>
            </label>
          );
        })}
      </div>

      {savedNotice && (
        <p
          style={{
            color: 'var(--color-accent)',
            fontSize: 12,
            marginTop: 6,
          }}
        >
          {savedNotice}
        </p>
      )}

      <div className="security-events-panel" data-testid="security-events-panel">
        <div className="security-events-header">
          <h4>{t('security.events.title')}</h4>
          <button
            type="button"
            className="security-events-refresh"
            onClick={() => void refreshStats()}
            disabled={statsLoading}
            aria-label={t('security.events.refresh')}
            title={t('security.events.refresh')}
          >
            <RefreshCw size={13} />
          </button>
        </div>

        {statsError && (
          <p style={{ color: 'var(--color-danger)', fontSize: 12 }}>
            {statsError}
          </p>
        )}

        {!stats && !statsError && (
          <p className="config-hint" style={{ margin: 0 }}>
            {t('security.events.loading')}
          </p>
        )}

        {stats && stats.total === 0 && (
          <p className="config-hint" style={{ margin: 0 }}>
            {t('security.events.none')}
          </p>
        )}

        {stats && stats.total > 0 && (
          <>
            <div className="security-events-summary">
              <div>
                <span className="security-events-stat-num">{stats.total}</span>
                <span className="security-events-stat-label">
                  {t('security.events.total')}
                </span>
              </div>
              {stats.firstAt && stats.lastAt && (
                <div className="security-events-range">
                  {t('security.events.rangeFrom')}{' '}
                  <code>{stats.firstAt.slice(0, 10)}</code>{' '}
                  {t('security.events.rangeTo')}{' '}
                  <code>{stats.lastAt.slice(0, 10)}</code>
                </div>
              )}
            </div>

            <div className="security-events-grid">
              <div className="security-events-card">
                <h5>{t('security.events.byKind')}</h5>
                <ul>
                  {(
                    Object.keys(stats.byKind) as Array<keyof typeof stats.byKind>
                  ).map((k) => (
                    <li key={k}>
                      <span>{KIND_KEYS[k] ? t(KIND_KEYS[k]) : k}</span>
                      <strong>{stats.byKind[k]}</strong>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="security-events-card">
                <h5>{t('security.events.bySeverity')}</h5>
                <ul>
                  <li>
                    <span className="severity-dot severity-high" />{' '}
                    {t('security.severity.high')}
                    <strong>{stats.bySeverity.high}</strong>
                  </li>
                  <li>
                    <span className="severity-dot severity-medium" />{' '}
                    {t('security.severity.medium')}
                    <strong>{stats.bySeverity.medium}</strong>
                  </li>
                  <li>
                    <span className="severity-dot severity-low" />{' '}
                    {t('security.severity.low')}
                    <strong>{stats.bySeverity.low}</strong>
                  </li>
                </ul>
              </div>
            </div>

            <details className="security-events-recent">
              <summary>
                {t('security.events.recent', { count: stats.recent.length })}
              </summary>
              <ul>
                {stats.recent.map((ev, idx) => (
                  <li
                    key={`${ev.at}-${ev.chunkId}-${idx}`}
                    className={`security-events-recent-item severity-${ev.severity ?? 'na'}`}
                  >
                    <span className="security-events-recent-when">
                      {formatRelative(ev.at, t, i18n.language)}
                    </span>
                    <span className="security-events-recent-kind">
                      {KIND_KEYS[ev.kind] ? t(KIND_KEYS[ev.kind]) : ev.kind}
                    </span>
                    {ev.pattern && (
                      <code className="security-events-recent-detail">
                        {ev.pattern}
                      </code>
                    )}
                    {ev.url && (
                      <code className="security-events-recent-detail">
                        {ev.url}
                      </code>
                    )}
                    {ev.detail && (
                      <code className="security-events-recent-detail">
                        {ev.detail}
                      </code>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </div>

      <HelpModal
        isOpen={helpOpen}
        onClose={() => setHelpOpen(false)}
        title={t('security.help.title')}
      >
        <p>
          {t('security.help.intro')} <em>prompt injection</em>.
        </p>
        <p>
          {t('security.help.scanBefore')}{' '}
          <code>.cliodeck/security-events.jsonl</code>.{' '}
          {t('security.help.scanAfter')}
        </p>

        <div className="help-mode-card">
          <p>
            <strong>{t('security.modes.warn.label')}</strong>{' '}
            {t('security.help.warn')}
          </p>
        </div>

        <div className="help-mode-card">
          <p>
            <strong>{t('security.modes.audit.label')}</strong>{' '}
            {t('security.help.audit')}
          </p>
        </div>

        <div className="help-mode-card">
          <p>
            <strong>{t('security.modes.block.label')}</strong>{' '}
            {t('security.help.block')}
          </p>
        </div>

        <h3>{t('security.help.blockedTitle')}</h3>
        <p>
          {t('security.help.blockedBefore')}{' '}
          <code>prompt_injection_blocked</code>{' '}
          {t('security.help.blockedAfter')}
        </p>

        <h3>{t('security.help.patternsTitle')}</h3>
        <ul>
          <li>
            <strong>{t('security.help.patternsHigh.label')}</strong>{' '}
            {t('security.help.patternsHigh.text')}
          </li>
          <li>
            <strong>{t('security.help.patternsMedium.label')}</strong>{' '}
            {t('security.help.patternsMedium.text')}
          </li>
          <li>
            <strong>{t('security.help.patternsLow.label')}</strong>{' '}
            {t('security.help.patternsLow.text')}
          </li>
        </ul>

        <div className="help-callout">
          <strong>{t('security.help.tensionTitle')}</strong>{' '}
          {t('security.help.tension')}
        </div>

        <h3>{t('security.help.whereTitle')}</h3>
        <p>
          {t('security.help.whereBefore')}{' '}
          <code>.cliodeck/security-events.jsonl</code>{' '}
          {t('security.help.whereAfter')}
        </p>
      </HelpModal>

      {/* Credential revocation (ADR 0006) */}
      <div className="security-revoke-section">
        <h4 className="security-revoke-title">
          <KeyRound size={14} /> {t('security.revokeTitle')}
        </h4>
        <p className="config-hint">
          {t('security.revokeDescription')}
        </p>
        <button
          type="button"
          className="security-revoke-btn"
          disabled={revoking}
          onClick={async () => {
            const confirmed = await useDialogStore
              .getState()
              .showConfirm(t('security.revokeConfirm'));
            if (!confirmed) return;
            setRevoking(true);
            try {
              const s = api();
              const res = await s?.revokeAllKeys?.();
              if (res?.success) {
                setSavedNotice(
                  t('security.revokeSuccess', { count: res.keysDeleted ?? 0 })
                );
                window.setTimeout(() => setSavedNotice(null), 4000);
              } else {
                setError(res?.error ?? t('security.revokeError'));
              }
            } catch {
              setError(t('security.revokeError'));
            } finally {
              setRevoking(false);
            }
          }}
        >
          {revoking ? t('security.revoking') : t('security.revokeButton')}
        </button>
      </div>
    </section>
  );
};
