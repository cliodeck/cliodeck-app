/**
 * Centralized error handling utilities for IPC handlers
 */
import type { Outcome } from '../../../../backend/types/outcome.js';

export interface IPCErrorResponse {
  success: false;
  error: string;
}

/**
 * Un échec qui dit son code (L09-2) : `errorCode` est relatif à `messages.*` des locales,
 * `error` reste pour les appelants qui ne lisent que lui.
 */
export interface IPCOutcomeErrorResponse extends IPCErrorResponse {
  errorCode: string;
  errorParams?: Record<string, string | number>;
}

export interface IPCSuccessResponse<T = any> {
  success: true;
  [key: string]: any;
}

export type IPCResponse<T = any> = IPCSuccessResponse<T> | IPCErrorResponse;

/**
 * Wraps an IPC handler with try-catch error handling
 * @param handler The async handler function to wrap
 * @param context Context string for logging (e.g., 'project:create')
 * @returns Wrapped handler that always returns an IPCResponse
 */
export function wrapIPCHandler<TArgs extends any[], TResult>(
  handler: (...args: TArgs) => Promise<TResult>,
  context: string
): (...args: TArgs) => Promise<IPCResponse<TResult>> {
  return async (...args: TArgs): Promise<IPCResponse<TResult>> => {
    console.log(`📞 IPC Call: ${context}`, args.length > 1 ? args.slice(1) : '');
    try {
      const result = await handler(...args);
      console.log(`📤 IPC Response: ${context} - success`);
      return { success: true, ...result } as IPCSuccessResponse<TResult>;
    } catch (error: unknown) {
      console.error(`❌ ${context} error:`, error);
      return errorResponse(error);
    }
  };
}

/**
 * Creates a simple success response
 */
export function successResponse<T extends Record<string, any>>(data?: T): IPCSuccessResponse<T> {
  return { success: true, ...(data || {}) } as IPCSuccessResponse<T>;
}

/**
 * Creates a simple error response
 */
export function errorResponse(error: unknown): IPCErrorResponse {
  // Accepte `unknown` pour que les handlers puissent utiliser
  // `catch (error: unknown)` — un `catch` typé `any` laissait passer
  // n'importe quel accès de propriété sur une valeur dont on ne sait rien.
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : String(error);
  return { success: false, error: message };
}

/** Les clés de l'enveloppe : une valeur qui en porterait une l'écraserait. */
const OUTCOME_ENVELOPE_KEYS = ['success', 'error', 'errorCode', 'errorParams', 'warnings'] as const;

/**
 * Projette un `Outcome` sur la forme étalée des réponses IPC (L09-2). Un appelant qui ne lit
 * que `success` continue de fonctionner ; `warnings` s'ajoute sans casser personne.
 *
 * - ok → `{ success: true, ...value }`
 * - partial → `{ success: true, ...value, warnings }`
 * - failed → `{ success: false, error: message ?? code, errorCode: code, errorParams? }`
 *
 * Le renderer la relit par `readOutcome` ou `unwrapIpc` (`src/renderer/src/utils/ipc-outcome.ts`).
 */
export function outcomeResponse<T extends Record<string, unknown>>(o: Outcome<T>): IPCResponse {
  if (o.status === 'failed') {
    const { code, message, params } = o.error;
    const response: IPCOutcomeErrorResponse = {
      success: false,
      error: message ?? code,
      errorCode: code,
      ...(params && { errorParams: params }),
    };
    return response;
  }
  const clash = OUTCOME_ENVELOPE_KEYS.filter((key) => key in o.value);
  if (clash.length > 0) {
    throw new Error(`outcomeResponse : la valeur porte une clé de l'enveloppe (${clash.join(', ')})`);
  }
  return o.status === 'partial'
    ? { success: true, ...o.value, warnings: o.warnings }
    : { success: true, ...o.value };
}

/**
 * Validates that a project is currently open
 * @throws Error if no project is open
 */
export function requireProject(projectPath: string | null): asserts projectPath is string {
  if (!projectPath) {
    throw new Error('No project is currently open. Please open or create a project first.');
  }
}
