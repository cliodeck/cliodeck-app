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
export declare function wrapIPCHandler<TArgs extends any[], TResult>(handler: (...args: TArgs) => Promise<TResult>, context: string): (...args: TArgs) => Promise<IPCResponse<TResult>>;
/**
 * Creates a simple success response
 */
export declare function successResponse<T extends Record<string, any>>(data?: T): IPCSuccessResponse<T>;
/**
 * Creates a simple error response
 */
export declare function errorResponse(error: string | Error): IPCErrorResponse;
/**
 * Validates that a project is currently open
 * @throws Error if no project is open
 */
export declare function requireProject(projectPath: string | null): asserts projectPath is string;
