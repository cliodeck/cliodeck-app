import React, { useEffect, useMemo, useState } from 'react';
import { CollapsibleSection } from '../common/CollapsibleSection';
import {
  useUsageJournalStore,
  type UsageSessionSummary,
  type Verdict,
} from '../../stores/usageJournalStore';
import './UsageJournalSection.css';

/**
 * Journal d'usage IA — panneau minimal (résumé du jour + annotation).
 *
 * Distinct du journal de recherche. Instrument réflexif : volumes + décisions, jamais
 * les prompts. Objectif d'ergonomie : annoter une journée en < 2 min (instructions §4).
 */

const VERDICT_LABELS: Record<Verdict, string> = {
  worth_it: 'Valait le coup',
  not_worth_it: 'Ne valait pas le coup',
  unsure: 'Incertain',
  pending: 'En attente',
};

function fmt(n: number): string {
  return n.toLocaleString('fr-FR');
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const UsageJournalSection: React.FC = () => {
  const today = useUsageJournalStore((s) => s.today);
  const loading = useUsageJournalStore((s) => s.loading);
  const saving = useUsageJournalStore((s) => s.saving);
  const error = useUsageJournalStore((s) => s.error);
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
      alternative: alternative.trim() || 'aucune raisonnable',
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

  const title = useMemo(
    () => `Journal d'usage IA${uncovered > 0 ? ` · ${uncovered} à annoter` : ''}`,
    [uncovered]
  );

  return (
    <CollapsibleSection title={title} defaultExpanded={false}>
      <div className="usage-journal">
        <p className="usage-journal__intro">
          Instrument réflexif sur vos usages d’inférence (volumes et décisions), distinct
          du journal de recherche. Aucun prompt n’est enregistré ici.
        </p>

        {loading && <p className="usage-journal__muted">Chargement…</p>}
        {error && <p className="usage-journal__error">{error}</p>}

        {summary && (
          <>
            <div className="usage-journal__totals">
              <strong>{fmt(summary.totalEvents)}</strong> appels ·{' '}
              <strong>{fmt(summary.totalTokens)}</strong> tokens (local{' '}
              {fmt(summary.localTokens)} / cloud {fmt(summary.cloudTokens)})
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
                Tâche
                <input
                  type="text"
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  placeholder="ex. ré-indexation corpus Lester après +40 documents"
                />
              </label>
              <label>
                Alternative non-IA
                <input
                  type="text"
                  value={alternative}
                  onChange={(e) => setAlternative(e.target.value)}
                  placeholder="vide = « aucune raisonnable »"
                />
              </label>
              <label>
                Pourquoi l’alternative a été écartée
                <textarea
                  rows={2}
                  value={justification}
                  onChange={(e) => setJustification(e.target.value)}
                />
              </label>
              <label>
                Verdict
                <select value={verdict} onChange={(e) => setVerdict(e.target.value as Verdict)}>
                  {(Object.keys(VERDICT_LABELS) as Verdict[]).map((v) => (
                    <option key={v} value={v}>
                      {VERDICT_LABELS[v]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Note de verdict (optionnel)
                <input
                  type="text"
                  value={verdictNote}
                  onChange={(e) => setVerdictNote(e.target.value)}
                />
              </label>

              {sessions.length > 0 && (
                <fieldset className="usage-journal__sessions">
                  <legend>Rattacher des sessions du jour</legend>
                  {sessions.map((s: UsageSessionSummary) => (
                    <label key={s.id} className="usage-journal__session">
                      <input
                        type="checkbox"
                        checked={selected.has(s.id)}
                        onChange={() => toggleSession(s.id)}
                      />
                      <span>
                        {hhmm(s.startedAt)}–{hhmm(s.endedAt)} · {fmt(s.events)} appels,{' '}
                        {fmt(s.totalTokens)} tokens · [{s.modes.join(', ')}]
                        {s.covered && <span className="usage-journal__tag">déjà rattachée</span>}
                        {!s.covered && s.substantial && (
                          <span className="usage-journal__tag usage-journal__tag--warn">
                            non annotée
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}

              <div className="usage-journal__actions">
                <button onClick={onSave} disabled={!canSave}>
                  {saving ? 'Enregistrement…' : 'Enregistrer la décision'}
                </button>
                {savedFlash && <span className="usage-journal__ok">✓ Enregistré</span>}
              </div>
            </div>

            {today && today.decisions.length > 0 && (
              <div className="usage-journal__decisions">
                <h4>Décisions du jour</h4>
                <ul>
                  {today.decisions.map((d) => (
                    <li key={d.id}>
                      <strong>{d.task}</strong> — {VERDICT_LABELS[d.verdict]}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </CollapsibleSection>
  );
};
