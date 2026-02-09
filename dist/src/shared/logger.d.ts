/**
 * Centralized Logger for ClioDesk
 *
 * Provides a unified logging system with:
 * - Log levels (debug, info, warn, error)
 * - Environment-aware filtering (dev vs production)
 * - Contextual prefixes for easy filtering
 *
 * Usage:
 *   import { logger } from '@shared/logger';
 *   logger.debug('MyContext', 'Debug message', { data });
 *   logger.info('MyContext', 'Info message');
 *   logger.warn('MyContext', 'Warning message');
 *   logger.error('MyContext', 'Error message', error);
 *
 * Environment variables:
 *   CLIODESK_LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error' (default: 'warn' in prod, 'debug' in dev)
 *   CLIODESK_DEBUG: '1' to enable debug logs in production
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
declare class Logger {
    private config;
    private isProduction;
    constructor();
    private detectProduction;
    private getDefaultConfig;
    private getEnvLogLevel;
    private isDebugEnabled;
    private shouldLog;
    private formatMessage;
    /**
     * Set the minimum log level
     */
    setLevel(level: LogLevel): void;
    /**
     * Get the current log level
     */
    getLevel(): LogLevel;
    /**
     * Check if running in production mode
     */
    isProductionMode(): boolean;
    /**
     * Debug level logging - for development and troubleshooting
     */
    debug(context: string, message: string, ...args: unknown[]): void;
    /**
     * Info level logging - for important operational information
     */
    info(context: string, message: string, ...args: unknown[]): void;
    /**
     * Warning level logging - for non-critical issues
     */
    warn(context: string, message: string, ...args: unknown[]): void;
    /**
     * Error level logging - for errors and exceptions
     */
    error(context: string, message: string, ...args: unknown[]): void;
    /**
     * Create a child logger with a fixed context
     */
    createContextLogger(context: string): ContextLogger;
}
/**
 * Context-bound logger for use within a specific module/service
 */
declare class ContextLogger {
    private parent;
    private context;
    constructor(parent: Logger, context: string);
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
export declare const logger: Logger;
export { Logger, ContextLogger };
