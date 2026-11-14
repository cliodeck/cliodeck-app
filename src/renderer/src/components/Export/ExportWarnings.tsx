import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import type { OutcomeIssue } from '@backend/types/outcome';
import { readOutcome } from '../../utils/ipc-outcome';
import { translateMessage } from '../../utils/translate-message';

/**
 * Les réserves d'un export qui a écrit son document (A27) : le seul affichage des avertissements
 * d'export, partagé par les modales PDF, Word et présentation. Le document est là, mais il lui
 * manque quelque chose : la modale reste ouverte pour que l'auteur le lise.
 *
 * Deux sources, dans la même réponse du main :
 *  - les avertissements de l'enveloppe (`warnings`, `outcomeResponse(partial(…))`, L09-2), codes
 *    relatifs à `messages.*`, traduits par `translateMessage` (une image introuvable, L07-2) ;
 *  - les champs de la réponse que les exports portaient déjà : clés de citation non résolues,
 *    style CSL du projet introuvable ou inapplicable sans pandoc (BT1-4).
 */

/**
 * `WordExportResult.unusableCsl`, côté main : pourquoi le moteur interne n'a
 * pas appliqué le style du projet, et le message qui le dit.
 */
const UNUSABLE_CSL_MESSAGES = {
  dependent: 'export.cslDependent',
  unreadable: 'export.cslUnreadable',
  numeric: 'export.cslNumeric',
} as const;

interface UnusableCsl {
  path: string;
  reason: keyof typeof UNUSABLE_CSL_MESSAGES;
}

export interface ExportWarningsValue {
  issues: OutcomeIssue[];
  unresolvedCitations: string[];
  missingCsl: string | null;
  unusableCsl: UnusableCsl | null;
}

export const NO_EXPORT_WARNINGS: ExportWarningsValue = {
  issues: [],
  unresolvedCitations: [],
  missingCsl: null,
  unusableCsl: null,
};

/** Le résultat arrive de l'IPC sans type : seule une forme connue s'affiche. */
function readUnusableCsl(value: unknown): UnusableCsl | null {
  if (!value || typeof value !== 'object') return null;
  const { path, reason } = value as { path?: unknown; reason?: unknown };
  const known = (Object.keys(UNUSABLE_CSL_MESSAGES) as UnusableCsl['reason'][]).find((r) => r === reason);
  return typeof path === 'string' && known ? { path, reason: known } : null;
}

/** Les réserves d'une réponse d'export ; aucune pour un échec, qui a son propre message. */
export function readExportWarnings(response: unknown): ExportWarningsValue {
  const outcome = readOutcome<Record<string, unknown>>(response);
  if (outcome.status === 'failed') return NO_EXPORT_WARNINGS;
  const { value } = outcome;
  const unresolved = value.unresolvedCitations;
  return {
    issues: outcome.status === 'partial' ? outcome.warnings : [],
    unresolvedCitations: Array.isArray(unresolved)
      ? unresolved.filter((key): key is string => typeof key === 'string')
      : [],
    missingCsl: typeof value.missingCsl === 'string' ? value.missingCsl : null,
    unusableCsl: readUnusableCsl(value.unusableCsl),
  };
}

export function hasExportWarnings(w: ExportWarningsValue): boolean {
  return w.issues.length > 0 || w.unresolvedCitations.length > 0 || !!w.missingCsl || !!w.unusableCsl;
}

export const ExportWarnings: React.FC<{ warnings: ExportWarningsValue }> = ({ warnings }) => {
  const { t } = useTranslation('common');
  const { issues, unresolvedCitations, missingCsl, unusableCsl } = warnings;

  return (
    <>
      {issues.map((issue, i) => (
        <div key={`${issue.code}-${i}`} className="export-error" data-testid="export-warning">
          <AlertCircle size={16} />
          <span>{translateMessage(t, issue)}</span>
        </div>
      ))}

      {unresolvedCitations.length > 0 && (
        <div className="export-error" data-testid="export-unresolved-citations">
          <AlertCircle size={16} />
          <span>
            {t('export.word.unresolvedCitations', { keys: unresolvedCitations.join(', ') })}
          </span>
        </div>
      )}

      {missingCsl && (
        <div className="export-error" data-testid="export-csl-missing">
          <AlertCircle size={16} />
          <span>{t('export.cslMissing', { file: missingCsl })}</span>
        </div>
      )}

      {unusableCsl && (
        <div className="export-error" data-testid="export-csl-unusable">
          <AlertCircle size={16} />
          <span>{t(UNUSABLE_CSL_MESSAGES[unusableCsl.reason], { file: unusableCsl.path })}</span>
        </div>
      )}
    </>
  );
};
