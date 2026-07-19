/**
 * Centralized error handling utilities for IPC handlers
 */

export interface IPCErrorResponse {
  success: false;
  error: string;
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

/**
 * Validates that a project is currently open
 * @throws Error if no project is open
 */
export function requireProject(projectPath: string | null): asserts projectPath is string {
  if (!projectPath) {
    throw new Error('No project is currently open. Please open or create a project first.');
  }
}
