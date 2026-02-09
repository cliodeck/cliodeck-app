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
const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
const LEVEL_EMOJI = {
    debug: '🔍',
    info: '📘',
    warn: '⚠️',
    error: '❌',
};
const LEVEL_COLORS = {
    debug: '\x1b[36m', // cyan
    info: '\x1b[32m', // green
    warn: '\x1b[33m', // yellow
    error: '\x1b[31m', // red
};
const RESET_COLOR = '\x1b[0m';
class Logger {
    constructor() {
        this.isProduction = this.detectProduction();
        this.config = this.getDefaultConfig();
    }
    detectProduction() {
        // Check various environment indicators
        if (typeof process !== 'undefined') {
            return (process.env.NODE_ENV === 'production' ||
                process.env.ELECTRON_IS_PACKAGED === 'true');
        }
        return false;
    }
    getDefaultConfig() {
        const envLevel = this.getEnvLogLevel();
        const debugEnabled = this.isDebugEnabled();
        let level;
        if (envLevel) {
            level = envLevel;
        }
        else if (debugEnabled) {
            level = 'debug';
        }
        else if (this.isProduction) {
            level = 'warn';
        }
        else {
            level = 'debug';
        }
        return {
            level,
            enableEmoji: true,
            enableTimestamp: false, // Keep logs concise
        };
    }
    getEnvLogLevel() {
        if (typeof process !== 'undefined' && process.env.CLIODESK_LOG_LEVEL) {
            const level = process.env.CLIODESK_LOG_LEVEL.toLowerCase();
            if (level in LOG_LEVELS) {
                return level;
            }
        }
        return null;
    }
    isDebugEnabled() {
        if (typeof process !== 'undefined') {
            return process.env.CLIODESK_DEBUG === '1' || process.env.DEBUG === '1';
        }
        return false;
    }
    shouldLog(level) {
        return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
    }
    formatMessage(level, context, message) {
        const parts = [];
        if (this.config.enableTimestamp) {
            parts.push(`[${new Date().toISOString()}]`);
        }
        if (this.config.enableEmoji) {
            parts.push(LEVEL_EMOJI[level]);
        }
        parts.push(`[${context}]`);
        parts.push(message);
        return parts.join(' ');
    }
    /**
     * Set the minimum log level
     */
    setLevel(level) {
        this.config.level = level;
    }
    /**
     * Get the current log level
     */
    getLevel() {
        return this.config.level;
    }
    /**
     * Check if running in production mode
     */
    isProductionMode() {
        return this.isProduction;
    }
    /**
     * Debug level logging - for development and troubleshooting
     */
    debug(context, message, ...args) {
        if (!this.shouldLog('debug'))
            return;
        const formatted = this.formatMessage('debug', context, message);
        console.log(formatted, ...args);
    }
    /**
     * Info level logging - for important operational information
     */
    info(context, message, ...args) {
        if (!this.shouldLog('info'))
            return;
        const formatted = this.formatMessage('info', context, message);
        console.log(formatted, ...args);
    }
    /**
     * Warning level logging - for non-critical issues
     */
    warn(context, message, ...args) {
        if (!this.shouldLog('warn'))
            return;
        const formatted = this.formatMessage('warn', context, message);
        console.warn(formatted, ...args);
    }
    /**
     * Error level logging - for errors and exceptions
     */
    error(context, message, ...args) {
        if (!this.shouldLog('error'))
            return;
        const formatted = this.formatMessage('error', context, message);
        console.error(formatted, ...args);
    }
    /**
     * Create a child logger with a fixed context
     */
    createContextLogger(context) {
        return new ContextLogger(this, context);
    }
}
/**
 * Context-bound logger for use within a specific module/service
 */
class ContextLogger {
    constructor(parent, context) {
        this.parent = parent;
        this.context = context;
    }
    debug(message, ...args) {
        this.parent.debug(this.context, message, ...args);
    }
    info(message, ...args) {
        this.parent.info(this.context, message, ...args);
    }
    warn(message, ...args) {
        this.parent.warn(this.context, message, ...args);
    }
    error(message, ...args) {
        this.parent.error(this.context, message, ...args);
    }
}
// Export singleton instance
export const logger = new Logger();
// Export types and classes for advanced usage
export { Logger, ContextLogger };
