import type { TFunction } from 'i18next';

/**
 * Le seul traducteur des messages codés (A11, L09-2) : un `UserMessage` du main ou du backend,
 * un `OutcomeIssue`, une `IpcError`, tout ce qui porte un code relatif à `messages.*`.
 *
 * Un code que les locales connaissent donne sa phrase, paramètres interpolés. Sinon, la cause
 * brute (`message`), puis le statut d'un événement de progression (`status`, en français pour
 * les journaux et la CLI), puis le code lui-même : jamais une chaîne vide.
 */
export function translateMessage(
  t: TFunction,
  m: { code?: string; params?: Record<string, string | number>; message?: string; status?: string }
): string {
  const fallback = m.message || m.status || m.code || '';
  if (!m.code) return fallback;
  return t(`messages.${m.code}`, { ...m.params, defaultValue: fallback });
}
