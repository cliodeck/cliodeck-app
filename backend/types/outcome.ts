/**
 * Ce qu'une opération a donné : réussie, réussie en partie, ou échouée (L09-2).
 *
 * Une réponse du main disait jusqu'ici `{ success, error }`, et `success: true` ne laissait
 * aucune place à « enregistré, mais… » : l'avertissement se perdait, ou devenait un échec.
 * `partial` porte la valeur ET ce qui n'a pas pu se faire. Un problème est un `UserMessage`
 * (un code relatif à `messages.*`, ses paramètres), plus la cause brute du système, en secours,
 * quand aucune clé ne dit mieux (A11).
 *
 * Sur l'IPC, `outcomeResponse` (main) étale un `Outcome` dans la forme `{ success, … }` que
 * lisent les appelants existants ; `readOutcome` et `unwrapIpc` (renderer) la relisent.
 *
 * Sans dépendance : importable du backend, du main et du renderer.
 */
import type { UserMessage } from '../core/i18n/user-message.js';

export interface OutcomeIssue extends UserMessage {
  /** La cause brute (message d'erreur du système), affichée quand le code n'a pas de clé. */
  message?: string;
}

export type Outcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'partial'; value: T; warnings: OutcomeIssue[] }
  | { status: 'failed'; error: OutcomeIssue };

/**
 * Le code d'un échec que rien ne qualifie. Sans clé dans les locales, à dessein :
 * `translateMessage` rend alors la cause brute, la seule chose qu'on en sache.
 */
export const UNEXPECTED_ISSUE_CODE = 'errors.unexpected';

export function ok<T>(value: T): Outcome<T> {
  return { status: 'ok', value };
}

/** Sans avertissement, une réussite partielle est une réussite. */
export function partial<T>(value: T, warnings: OutcomeIssue[]): Outcome<T> {
  return warnings.length > 0 ? { status: 'partial', value, warnings } : { status: 'ok', value };
}

/** La cause brute d'un échec, comme `errorResponse` la lit. */
function causeMessage(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (typeof cause === 'string') return cause;
  return cause instanceof Error ? cause.message : String(cause);
}

export function failed(
  cause: unknown,
  code: string = UNEXPECTED_ISSUE_CODE,
  params?: Record<string, string | number>
): Outcome<never> {
  const message = causeMessage(cause);
  return {
    status: 'failed',
    error: { code, ...(message !== undefined && { message }), ...(params && { params }) },
  };
}
