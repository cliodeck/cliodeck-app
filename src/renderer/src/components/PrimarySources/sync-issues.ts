import type { TFunction } from 'i18next';
import type { TropySyncIssue } from '@backend/integrations/tropy/TropySync';
import type { NotIndexedReason } from '../../stores/primarySourcesStore';

/**
 * Le texte, dans la langue de l'interface, de ce qui a empêché une passe
 * Tropy. Le main ne renvoie qu'un code et ses paramètres ; `errors` reste
 * pour la console.
 */
export function describeSyncIssue(t: TFunction, issue: TropySyncIssue): string {
  switch (issue.code) {
    case 'different-project':
      return issue.linkedName
        ? t('primarySources.issues.differentProject', {
            candidateName: issue.candidateName,
            linkedName: issue.linkedName,
            sourceCount: issue.sourceCount,
          })
        : t('primarySources.issues.differentProjectUnnamed', {
            candidateName: issue.candidateName,
            sourceCount: issue.sourceCount,
          });
    case 'embedding-failed':
      return t('primarySources.issues.embeddingFailed', { sources: issue.sources });
    case 'no-embedding-provider':
      return t('primarySources.issues.noEmbeddingProvider', { sources: issue.sources });
  }
}

/**
 * Un refus — la passe n'a rien fait — se dit par une alerte. Le reste décrit
 * un état qui peut durer (Ollama arrêté, aucun modèle) : une alerte à chaque
 * synchro harcèlerait, l'avis reste dans le panneau et le bilan de la passe.
 */
export function isSyncRefusal(issue: TropySyncIssue): boolean {
  return issue.code === 'different-project';
}

/**
 * Une transcription écrite (OCR manuel, import) que l'assistant ne cite pas
 * encore : « enregistrée, pas encore indexée », jamais « réussi » tout court.
 */
export function describeNotIndexed(t: TFunction, reason: NotIndexedReason): string {
  return reason === 'no-embedding-provider'
    ? t('primarySources.transcriptionNotIndexedNoProvider')
    : t('primarySources.transcriptionNotIndexed');
}

/** Une transcription que le main n'a pas écrite. */
export function describeNotSaved(t: TFunction, code?: 'source-not-found' | 'not-saved'): string {
  return code === 'source-not-found'
    ? t('primarySources.transcriptionSourceGone')
    : t('primarySources.transcriptionNotSaved');
}
