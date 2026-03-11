/**
 * Structured logging system for the main process.
 *
 * Provides level-filtered, single-line structured log output
 * that is easy to parse while remaining human-readable.
 *
 * Output format:
 *   [2026-02-19T20:00:00.000Z] INFO  [ipc] fs:read-directory { dirPath: "/home/user" }
 *
 * Usage:
 *   import { logger } from '../../utils/logger.js';
 *   logger.info('ipc', 'fs:read-directory', { dirPath });
 *   logger.error('ipc', 'fs:read-directory', { error: error.message });
 *
 *   // Measuring duration:
 *   const elapsed = logger.startTimer();
 *   await someWork();
 *   logger.info('ipc', 'pdf:index', { durationMs: elapsed() });
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  action: string;
  data?: Record<string, unknown>;
  duration?: number;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

class Logger {
  private level: LogLevel = 'info';

  /**
   * Set the minimum log level. Messages below this level are suppressed.
   * Accepts the level name as a string; invalid values are silently ignored.
   */
  setLevel(level: string): void {
    if (level in LEVEL_PRIORITY) {
      this.level = level as LogLevel;
    }
  }

  /**
   * Get the current minimum log level.
   */
  getLevel(): LogLevel {
    return this.level;
  }

  debug(module: string, action: string, data?: Record<string, unknown>): void {
    this.log('debug', module, action, data);
  }

  info(module: string, action: string, data?: Record<string, unknown>): void {
    this.log('info', module, action, data);
  }

  warn(module: string, action: string, data?: Record<string, unknown>): void {
    this.log('warn', module, action, data);
  }

  error(module: string, action: string, data?: Record<string, unknown>): void {
    this.log('error', module, action, data);
  }

  /**
   * Returns a function that, when called, returns the elapsed time in
   * milliseconds since `startTimer()` was invoked. Useful for measuring
   * operation duration without manual Date arithmetic.
   *
   * Example:
   *   const elapsed = logger.startTimer();
   *   await doWork();
   *   logger.info('service', 'doWork', { durationMs: elapsed() });
   */
  startTimer(): () => number {
    const start = Date.now();
    return () => Date.now() - start;
  }

  // -- internal --------------------------------------------------------

  private log(level: LogLevel, module: string, action: string, data?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.level]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const label = LEVEL_LABEL[level];
    const dataPart = data ? ' ' + this.formatData(data) : '';
    const line = `[${timestamp}] ${label} [${module}] ${action}${dataPart}`;

    // Use the appropriate console method so Electron captures severity correctly
    switch (level) {
      case 'debug':
        console.log(line);
        break;
      case 'info':
        console.log(line);
        break;
      case 'warn':
        console.warn(line);
        break;
      case 'error':
        console.error(line);
        break;
    }
  }

  /**
   * Format data as a compact, single-line JSON-like string.
   * Uses JSON.stringify for correctness, but keeps it on one line.
   */
  private formatData(data: Record<string, unknown>): string {
    try {
      return JSON.stringify(data);
    } catch {
      return '{ [unserializable] }';
    }
  }
}

export const logger = new Logger();
