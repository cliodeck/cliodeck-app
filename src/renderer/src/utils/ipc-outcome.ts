/**
 * Lire une réponse du main (L09-2).
 *
 * `ipcRenderer.invoke` résout toujours, même quand le handler a échoué : il répond
 * `{ success: false, error }`. Le `catch` d'un appelant qui ne lit pas `success` est donc du code
 * mort, et l'échec passe pour une réussite (« Enregistré » quand rien ne l'est). `unwrapIpc` fait
 * de cet échec une exception ; `readOutcome` relit la réponse en `Outcome`, avertissements
 * compris. Le texte d'un problème se demande à `translateMessage`.
 */
import {
  partial,
  UNEXPECTED_ISSUE_CODE,
  type Outcome,
  type OutcomeIssue,
} from '@backend/types/outcome';

/** Le main n'a rien répondu d'exploitable : un handler muet, une API absente. */
export const NO_RESPONSE_ISSUE_CODE = 'errors.noResponse';

/** Un échec répondu par le main, à traduire par `translateMessage`. */
export class IpcError extends Error {
  readonly code: string;
  readonly params?: Record<string, string | number>;

  constructor(issue: OutcomeIssue) {
    super(issue.message ?? issue.code);
    this.name = 'IpcError';
    this.code = issue.code;
    if (issue.params) this.params = issue.params;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParams(value: unknown): value is Record<string, string | number> {
  return (
    isRecord(value) &&
    Object.values(value).every((v) => typeof v === 'string' || typeof v === 'number')
  );
}

function readIssue(value: unknown): OutcomeIssue | null {
  if (!isRecord(value) || typeof value.code !== 'string') return null;
  return {
    code: value.code,
    ...(typeof value.message === 'string' && { message: value.message }),
    ...(isParams(value.params) && { params: value.params }),
  };
}

/**
 * Le problème d'une réponse `success: false`. Sans `errorCode` (un handler qui répond par
 * `errorResponse`), le code ne qualifie rien et `error` est la cause brute. `outcomeResponse`
 * écrit le code dans `error` quand l'échec n'avait pas de cause : ce n'en est pas une.
 */
function failureIssue(res: { error?: unknown; errorCode?: unknown; errorParams?: unknown }): OutcomeIssue {
  const code = typeof res.errorCode === 'string' ? res.errorCode : UNEXPECTED_ISSUE_CODE;
  const message = typeof res.error === 'string' && res.error !== res.errorCode ? res.error : undefined;
  return {
    code,
    ...(message !== undefined && { message }),
    ...(isParams(res.errorParams) && { params: res.errorParams }),
  };
}

/**
 * La réponse relue en `Outcome`. Une réponse sans enveloppe (un tableau, un objet sans
 * `success`) est sa propre valeur ; `success: true` sans avertissement rend `ok`.
 */
export function readOutcome<T>(res: unknown): Outcome<T> {
  if (res === undefined || res === null) {
    return { status: 'failed', error: { code: NO_RESPONSE_ISSUE_CODE } };
  }
  if (!isRecord(res) || !('success' in res)) return { status: 'ok', value: res as T };
  if (res.success === false) return { status: 'failed', error: failureIssue(res) };
  const value = Object.fromEntries(
    Object.entries(res).filter(([key]) => key !== 'success' && key !== 'warnings')
  );
  const warnings = Array.isArray(res.warnings)
    ? res.warnings.map(readIssue).filter((issue): issue is OutcomeIssue => issue !== null)
    : [];
  return partial(value as T, warnings);
}

/** La réponse même, ou une `IpcError` si le main a répondu un échec. */
export function unwrapIpc<T extends { success?: boolean; error?: string }>(res: T | undefined | null): T {
  if (res === undefined || res === null) throw new IpcError({ code: NO_RESPONSE_ISSUE_CODE });
  if (res.success === false) throw new IpcError(failureIssue(res));
  return res;
}
