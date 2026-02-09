/**
 * Console Filter for Production Mode
 *
 * This module overrides console.log and console.info in production
 * to reduce noise while keeping console.warn and console.error active.
 *
 * Usage:
 *   Import this file early in your application entry point:
 *   import '@shared/console-filter';
 *
 * Environment variables:
 *   CLIODESK_DEBUG=1 : Enable all console logs even in production
 *   CLIODESK_LOG_LEVEL=debug : Same effect as CLIODESK_DEBUG=1
 *
 * This is a pragmatic solution that:
 * - Doesn't require migrating all 850+ console.log calls
 * - Silences debug output in production builds
 * - Preserves warnings and errors for troubleshooting
 * - Can be bypassed with environment variables for debugging
 */
/**
 * Restore original console methods (useful for testing)
 */
export declare function restoreConsole(): void;
/**
 * Get access to original console methods (bypasses filter)
 */
export declare const rawConsole: {
    log: any;
    info: any;
    warn: any;
    error: any;
    debug: any;
};
/**
 * Check current filter status
 */
export declare function getFilterStatus(): {
    isProduction: boolean;
    isDebugEnabled: boolean;
    isFiltering: boolean;
};
