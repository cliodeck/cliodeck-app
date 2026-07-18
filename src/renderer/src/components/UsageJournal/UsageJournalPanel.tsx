import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useUsageJournalStore,
  type UsageSessionSummary,
  type Verdict,
} from '../../stores/usageJournalStore';
import './UsageJournalPanel.css';

/**
 * Journal d'usage IA — contenu du panneau (résumé du jour + annotation).
 *
 * Distinct du journal de recherche. Instrument réflexif : volumes + décisions, jamais
 * les prompts. Objectif d'ergonomie : annoter une journée en < 2 min (instructions §4).
 * Rendu dans une modale ouverte depuis le menu Affichage (Cmd/Ctrl+J).
 */

const VERDICTS: Verdict[] = ['worth_it', 'not_worth_it', 'unsure', 'pending'];

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const UsageJournalPanel: React.FC = () => {
  const { t, i18n } = useTranslation('common');
  const today = useUsageJournalStore((s) => s.today);
  const loading = useUsageJournalStore((s) => s.loading);
  const saving = useUsageJournalStore((s) => s.saving);
  const error = useUsageJournalStore((s) => s.error);
  const errorCode = useUsageJournalStore((s) => s.errorCode);
  const loadToday = useUsageJournalStore((s) => s.loadToday);
  const saveDecision = useUsageJournalStore((s) => s.saveDecision);

  const [task, setTask] = useState('');
  const [alternative, setAlternative] = useState('');
  const [justification, setJustification] = useState('');
  const [verdict, setVerdict] = useState<Verdict>('pending');
  const [verdictNote, setVerdictNote] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    void loadToday();
  }, [loadToday]);

  const fmt = (n: number): string => n.toLocaleString(i18n.language);
  const verdictLabel = (v: Verdict): string => t(`usageJournal.verdicts.${v}`);

  const summary = today?.summary;
  const sessions = summary?.sessions ?? [];
  const uncovered = summary?.violations.length ?? 0;

  const toggleSession = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const canSave = task.trim().length > 0 && !saving;

  const onSave = async () => {
    const ok = await saveDecision({
      task: task.trim(),
      // Vide = « aucune alternative raisonnable » : on persiste la chaîne vide
      // (valeur neutre en langue) et on traduit à l'affichage.
      alternative: alternative.trim(),
      justification: justification.trim(),
      verdict,
      verdictNote: verdictNote.trim() || undefined,
      sessionIds: [...selected],
    });
    if (ok) {
      setTask('');
      setAlternative('');
      setJustification('');
      setVerdict('pending');
      setVerdictNote('');
      setSelected(new Set());
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2500);
    }
  };

  return (
    <div className="usage-journal">
      <p className="usage-journal__intro">{t('usageJournal.intro')}</p>

      {loading && <p className="usage-journal__muted">{t('usageJournal.loading')}</p>}
      {errorCode === 'NO_PROJECT' ? (
        <p className="usage-journal__muted">{t('usageJournal.noProject')}</p>
      ) : (
        error && (
          <p className="usage-journal__error">
            {errorCode === 'SAVE_FAILED' ? t('usageJournal.saveFailed') : error}
          </p>
        )
      )}

      {summary && (
        <>
          <div className="usage-journal__totals">
            <strong>{fmt(summary.totalEvents)}</strong> {t('usageJournal.calls')} ·{' '}
            <strong>{fmt(summary.totalTokens)}</strong>{' '}
            {t('usageJournal.tokensBreakdown', {
              local: fmt(summary.localTokens),
              cloud: fmt(summary.cloudTokens),
            })}
            {uncovered > 0 && (
              <span className="usage-journal__badge">
                {t('usageJournal.badge', { count: uncovered })}
              </span>
            )}
          </div>

          {summary.byMode.length > 0 && (
            <div className="usage-journal__chips">
              {summary.byMode.map((m) => (
                <span key={m.mode} className="usage-journal__chip">
                  {m.mode} · {fmt(m.totalTokens)}
                </span>
              ))}
            </div>
          )}

          <div className="usage-journal__form">
            <label>
              {t('usageJournal.task')}
              <input
                type="text"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder={t('usageJournal.taskPlaceholder')}
              />
            </label>
            <label>
              {t('usageJournal.alternative')}
              <input
                type="text"
                value={alternative}
                onChange={(e) => setAlternative(e.target.value)}
                placeholder={t('usageJournal.alternativePlaceholder')}
              />
            </label>
            <label>
              {t('usageJournal.justification')}
              <textarea
                rows={2}
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
              />
            </label>
            <label>
              {t('usageJournal.verdict')}
              <select value={verdict} onChange={(e) => setVerdict(e.target.value as Verdict)}>
                {VERDICTS.map((v) => (
                  <option key={v} value={v}>
                    {verdictLabel(v)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('usageJournal.verdictNote')}
              <input
                type="text"
                value={verdictNote}
                onChange={(e) => setVerdictNote(e.target.value)}
              />
            </label>

            {sessions.length > 0 && (
              <fieldset className="usage-journal__sessions">
                <legend>{t('usageJournal.attachSessions')}</legend>
                {sessions.map((s: UsageSessionSummary) => (
                  <label key={s.id} className="usage-journal__session">
                    <input
                      type="checkbox"
                      checked={selected.has(s.id)}
                      onChange={() => toggleSession(s.id)}
                    />
                    <span>
                      {hhmm(s.startedAt)}–{hhmm(s.endedAt)} · {fmt(s.events)}{' '}
                      {t('usageJournal.calls')}, {fmt(s.totalTokens)} {t('usageJournal.tokens')} ·{' '}
                      [{s.modes.join(', ')}]
                      {s.covered && (
                        <span className="usage-journal__tag">{t('usageJournal.covered')}</span>
                      )}
                      {!s.covered && s.substantial && (
                        <span className="usage-journal__tag usage-journal__tag--warn">
                          {t('usageJournal.uncovered')}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}

            <div className="usage-journal__actions">
              <button onClick={onSave} disabled={!canSave}>
                {saving ? t('usageJournal.saving') : t('usageJournal.save')}
              </button>
              {savedFlash && <span className="usage-journal__ok">{t('usageJournal.saved')}</span>}
            </div>
          </div>

          {today && today.decisions.length > 0 && (
            <div className="usage-journal__decisions">
              <h4>{t('usageJournal.todayDecisions')}</h4>
              <ul>
                {today.decisions.map((d) => (
                  <li key={d.id}>
                    <strong>{d.task}</strong> — {verdictLabel(d.verdict)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
};
