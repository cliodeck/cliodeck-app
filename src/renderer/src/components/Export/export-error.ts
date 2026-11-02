import { ExportReadTimedOutError } from './export-read-limit';

type Translate = (key: string, options?: Record<string, string | number>) => string;

/**
 * Le message d'un export qui a échoué. Un dépassement de la limite de durée
 * arrive du main sous un code, avec les minutes de la limite appliquée ; les
 * autres erreurs gardent leur texte.
 */
export function exportErrorMessage(
  t: Translate,
  result: { error?: string; errorCode?: string; timeLimitMinutes?: number },
  fallback: string
): string {
  if (result.errorCode === 'export_timed_out') {
    return t('export.timedOut', { minutes: result.timeLimitMinutes ?? 0 });
  }
  return result.error || fallback;
}

/** Le message d'un export interrompu par une exception : même texte pour la limite des lectures. */
export function exportThrownMessage(t: Translate, err: unknown, fallback: string): string {
  return err instanceof ExportReadTimedOutError ? exportErrorMessage(t, err, fallback) : fallback;
}
