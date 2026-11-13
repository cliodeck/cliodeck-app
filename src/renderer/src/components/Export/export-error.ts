import type { TFunction } from 'i18next';
import { ExportReadTimedOutError } from './export-read-limit';
import { translateMessage } from '../../utils/translate-message';

type Translate = (key: string, options?: Record<string, string | number>) => string;

/**
 * Le message d'un export qui a échoué. Un dépassement de la limite de durée
 * arrive du main sous un code, avec les minutes de la limite appliquée. Un
 * échec qui porte un autre code (relatif à `messages.*` : une image que
 * pandoc n'a pas su convertir, L07-2) se dit par sa phrase, la sortie de
 * pandoc en repli. Les autres erreurs gardent leur texte.
 */
export function exportErrorMessage(
  t: Translate,
  result: {
    error?: string;
    errorCode?: string;
    errorParams?: Record<string, string | number>;
    timeLimitMinutes?: number;
  },
  fallback: string
): string {
  if (result.errorCode === 'export_timed_out') {
    return t('export.timedOut', { minutes: result.timeLimitMinutes ?? 0 });
  }
  if (result.errorCode) {
    // `translateMessage` n'appelle que `t(clé, { ...params, defaultValue })`, ce que `Translate`
    // accepte : les modales lui passent le `t` de react-i18next.
    return translateMessage(t as unknown as TFunction, {
      code: result.errorCode,
      params: result.errorParams,
      message: result.error || fallback,
    });
  }
  return result.error || fallback;
}

/** Le message d'un export interrompu par une exception : même texte pour la limite des lectures. */
export function exportThrownMessage(t: Translate, err: unknown, fallback: string): string {
  return err instanceof ExportReadTimedOutError ? exportErrorMessage(t, err, fallback) : fallback;
}
