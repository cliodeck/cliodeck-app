/**
 * Centralized error handling utilities for IPC handlers
 */
/**
 * Wraps an IPC handler with try-catch error handling
 * @param handler The async handler function to wrap
 * @param context Context string for logging (e.g., 'project:create')
 * @returns Wrapped handler that always returns an IPCResponse
 */
export function wrapIPCHandler(handler, context) {
    return async (...args) => {
        console.log(`📞 IPC Call: ${context}`, args.length > 1 ? args.slice(1) : '');
        try {
            const result = await handler(...args);
            console.log(`📤 IPC Response: ${context} - success`);
            return { success: true, ...result };
        }
        catch (error) {
            console.error(`❌ ${context} error:`, error);
            return {
                success: false,
                error: error.message || 'An unknown error occurred',
            };
        }
    };
}
/**
 * Creates a simple success response
 */
export function successResponse(data) {
    return { success: true, ...(data || {}) };
}
/**
 * Creates a simple error response
 */
export function errorResponse(error) {
    const message = typeof error === 'string' ? error : error.message;
    return { success: false, error: message };
}
/**
 * Validates that a project is currently open
 * @throws Error if no project is open
 */
export function requireProject(projectPath) {
    if (!projectPath) {
        throw new Error('No project is currently open. Please open or create a project first.');
    }
}
