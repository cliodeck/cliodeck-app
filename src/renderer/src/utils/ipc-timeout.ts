/**
 * IPC Request Timeout Utility
 *
 * Wraps IPC calls with automatic timeout to prevent UI freezing
 */

export class IPCTimeoutError extends Error {
  constructor(channel: string, timeout: number) {
    super(`IPC request to '${channel}' timed out after ${timeout}ms`);
    this.name = 'IPCTimeoutError';
  }
}

/**
 * Wraps an async function with a timeout
 * @param promise The promise to timeout
 * @param timeoutMs Timeout in milliseconds
 * @param channel Channel name for error messages
 * @returns Promise that rejects if timeout is reached
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  channel: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new IPCTimeoutError(channel, timeoutMs));
      }, timeoutMs);
    }),
  ]);
}

/**
 * Default timeout values for different types of operations
 */
export const TIMEOUTS = {
  // Fast operations (file reads, config)
  FAST: 5000, // 5 seconds

  // Medium operations (project loading, simple queries)
  MEDIUM: 15000, // 15 seconds

  // Slow operations (PDF indexing, RAG queries, exports)
  SLOW: 60000, // 60 seconds

  // Very slow operations (full corpus analysis, large exports)
  VERY_SLOW: 180000, // 3 minutes
};

/**
 * Wrapper for IPC calls with automatic timeout based on operation type
 */
export async function ipcWithTimeout<T>(
  ipcCall: () => Promise<T>,
  channel: string,
  timeout: number = TIMEOUTS.MEDIUM
): Promise<T> {
  try {
    return await withTimeout(ipcCall(), timeout, channel);
  } catch (error) {
    if (error instanceof IPCTimeoutError) {
      console.error(`⏱️ Timeout on IPC channel '${channel}' after ${timeout}ms`);
    }
    throw error;
  }
}
