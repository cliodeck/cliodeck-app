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

type ConsoleMethod = (...args: unknown[]) => void;

interface ConsoleFilterConfig {
  filterLog: boolean;
  filterInfo: boolean;
  filterWarn: boolean;
  filterError: boolean;
}

// Store original console methods
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

/**
 * Detect if running in production mode
 */
function isProduction(): boolean {
  if (typeof process !== 'undefined') {
    return (
      process.env.NODE_ENV === 'production' ||
      process.env.ELECTRON_IS_PACKAGED === 'true'
    );
  }
  return false;
}

/**
 * Check if debug mode is explicitly enabled
 */
function isDebugEnabled(): boolean {
  if (typeof process !== 'undefined') {
    return (
      process.env.CLIODESK_DEBUG === '1' ||
      process.env.DEBUG === '1' ||
      process.env.CLIODESK_LOG_LEVEL === 'debug'
    );
  }
  return false;
}

/**
 * Get the filter configuration based on environment
 */
function getFilterConfig(): ConsoleFilterConfig {
  const production = isProduction();
  const debugEnabled = isDebugEnabled();

  // In development or with debug enabled, don't filter anything
  if (!production || debugEnabled) {
    return {
      filterLog: false,
      filterInfo: false,
      filterWarn: false,
      filterError: false,
    };
  }

  // In production without debug, filter log and info
  return {
    filterLog: true,
    filterInfo: true,
    filterWarn: false,
    filterError: false,
  };
}

/**
 * Create a filtered console method
 */
function createFilteredMethod(
  original: ConsoleMethod,
  shouldFilter: boolean
): ConsoleMethod {
  if (!shouldFilter) {
    return original;
  }

  return (..._args: unknown[]) => {
    // Silently ignore in production
  };
}

/**
 * Install the console filter
 */
function installConsoleFilter(): void {
  const config = getFilterConfig();

  console.log = createFilteredMethod(originalConsole.log, config.filterLog);
  console.info = createFilteredMethod(originalConsole.info, config.filterInfo);
  console.debug = createFilteredMethod(originalConsole.log, config.filterLog);

  // Always keep warn and error
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;

  // Log that filtering is active (using original to bypass filter)
  if (config.filterLog) {
    originalConsole.info(
      '[ClioDesk] Production mode: console.log/info filtered. Set CLIODESK_DEBUG=1 to enable.'
    );
  }
}

/**
 * Restore original console methods (useful for testing)
 */
export function restoreConsole(): void {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.debug = originalConsole.debug;
}

/**
 * Get access to original console methods (bypasses filter)
 */
export const rawConsole = originalConsole;

/**
 * Check current filter status
 */
export function getFilterStatus(): {
  isProduction: boolean;
  isDebugEnabled: boolean;
  isFiltering: boolean;
} {
  const production = isProduction();
  const debugEnabled = isDebugEnabled();

  return {
    isProduction: production,
    isDebugEnabled: debugEnabled,
    isFiltering: production && !debugEnabled,
  };
}

// Auto-install on import
installConsoleFilter();
