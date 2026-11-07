import type { TFunction } from 'i18next';
import type { TropySyncIssue } from '@backend/integrations/tropy/TropySync';
import { usePrimarySourcesStore, type NotIndexedReason } from '../../stores/primarySourcesStore';

/**
 * Le système, d'après le navigateur d'Electron : la marche à suivre pour
 * installer Poppler en dépend.
 */
function installPlatform(): 'win32' | 'darwin' | 'linux' {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/.test(userAgent)) return 'win32';
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'darwin';
  return 'linux';
}

/** Le nom de la langue tel que la liste de la modale OCR l'affiche, à défaut son code. */
function ocrLanguageName(code: string): string {
  return usePrimarySourcesStore.getState().availableOCRLanguages.find((l) => l.code === code)?.name ?? code;
}

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
    case 'poppler-missing': {
      // Des clés écrites en entier : le test des clés appelées les voit.
      const platform = installPlatform();
      return platform === 'win32'
        ? t('primarySources.issues.popplerMissingWindows')
        : platform === 'darwin'
          ? t('primarySources.issues.popplerMissingMac')
          : t('primarySources.issues.popplerMissingLinux');
    }
    case 'ocr-language-unavailable':
      return t('primarySources.issues.ocrLanguageUnavailable', { language: ocrLanguageName(issue.language) });
  }
}

/**
 * Un refus — la passe n'a rien fait — se dit par une alerte. Le reste décrit
 * un état qui peut durer (Ollama arrêté, aucun modèle, Poppler absent, pas de
 * réseau pour un modèle de langue) : une alerte à chaque synchro harcèlerait,
 * l'avis reste dans le panneau et le bilan de la passe.
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
