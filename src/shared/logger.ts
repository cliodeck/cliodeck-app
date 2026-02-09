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

interface LoggerConfig {
  level: LogLevel;
  enableEmoji: boolean;
  enableTimestamp: boolean;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_EMOJI: Record<LogLevel, string> = {
  debug: '🔍',
  info: '📘',
  warn: '⚠️',
  error: '❌',
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};

const RESET_COLOR = '\x1b[0m';

class Logger {
  private config: LoggerConfig;
  private isProduction: boolean;

  constructor() {
    this.isProduction = this.detectProduction();
    this.config = this.getDefaultConfig();
  }

  private detectProduction(): boolean {
    // Check various environment indicators
    if (typeof process !== 'undefined') {
      return (
        process.env.NODE_ENV === 'production' ||
        process.env.ELECTRON_IS_PACKAGED === 'true'
      );
    }
    return false;
  }

  private getDefaultConfig(): LoggerConfig {
    const envLevel = this.getEnvLogLevel();
    const debugEnabled = this.isDebugEnabled();

    let level: LogLevel;
    if (envLevel) {
      level = envLevel;
    } else if (debugEnabled) {
      level = 'debug';
    } else if (this.isProduction) {
      level = 'warn';
    } else {
      level = 'debug';
    }

    return {
      level,
      enableEmoji: true,
      enableTimestamp: false, // Keep logs concise
    };
  }

  private getEnvLogLevel(): LogLevel | null {
    if (typeof process !== 'undefined' && process.env.CLIODESK_LOG_LEVEL) {
      const level = process.env.CLIODESK_LOG_LEVEL.toLowerCase() as LogLevel;
      if (level in LOG_LEVELS) {
        return level;
      }
    }
    return null;
  }

  private isDebugEnabled(): boolean {
    if (typeof process !== 'undefined') {
      return process.env.CLIODESK_DEBUG === '1' || process.env.DEBUG === '1';
    }
    return false;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
  }

  private formatMessage(
    level: LogLevel,
    context: string,
    message: string
  ): string {
    const parts: string[] = [];

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
  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  /**
   * Get the current log level
   */
  getLevel(): LogLevel {
    return this.config.level;
  }

  /**
   * Check if running in production mode
   */
  isProductionMode(): boolean {
    return this.isProduction;
  }

  /**
   * Debug level logging - for development and troubleshooting
   */
  debug(context: string, message: string, ...args: unknown[]): void {
    if (!this.shouldLog('debug')) return;
    const formatted = this.formatMessage('debug', context, message);
    console.log(formatted, ...args);
  }

  /**
   * Info level logging - for important operational information
   */
  info(context: string, message: string, ...args: unknown[]): void {
    if (!this.shouldLog('info')) return;
    const formatted = this.formatMessage('info', context, message);
    console.log(formatted, ...args);
  }

  /**
   * Warning level logging - for non-critical issues
   */
  warn(context: string, message: string, ...args: unknown[]): void {
    if (!this.shouldLog('warn')) return;
    const formatted = this.formatMessage('warn', context, message);
    console.warn(formatted, ...args);
  }

  /**
   * Error level logging - for errors and exceptions
   */
  error(context: string, message: string, ...args: unknown[]): void {
    if (!this.shouldLog('error')) return;
    const formatted = this.formatMessage('error', context, message);
    console.error(formatted, ...args);
  }

  /**
   * Create a child logger with a fixed context
   */
  createContextLogger(context: string): ContextLogger {
    return new ContextLogger(this, context);
  }
}

/**
 * Context-bound logger for use within a specific module/service
 */
class ContextLogger {
  constructor(
    private parent: Logger,
    private context: string
  ) {}

  debug(message: string, ...args: unknown[]): void {
    this.parent.debug(this.context, message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.parent.info(this.context, message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.parent.warn(this.context, message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.parent.error(this.context, message, ...args);
  }
}

// Export singleton instance
export const logger = new Logger();

// Export types and classes for advanced usage
export { Logger, ContextLogger };
