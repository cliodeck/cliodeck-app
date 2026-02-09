/**
 * Custom hook for IPC calls with automatic timeout protection
 */
import { useCallback } from 'react';
import { ipcWithTimeout, TIMEOUTS, IPCTimeoutError } from '../utils/ipc-timeout';

/**
 * Hook that provides timeout-protected IPC calls
 * Automatically logs errors and provides consistent error handling
 */
export function useIPCWithTimeout() {
  const callWithTimeout = useCallback(
    async <T>(
      ipcCall: () => Promise<T>,
      channel: string,
      timeout: number = TIMEOUTS.MEDIUM,
      onTimeout?: () => void
    ): Promise<T> => {
      try {
        return await ipcWithTimeout(ipcCall, channel, timeout);
      } catch (error) {
        if (error instanceof IPCTimeoutError) {
          console.error(`⏱️ IPC timeout on '${channel}'`);
          onTimeout?.();
        }
        throw error;
      }
    },
    []
  );

  return {
    callWithTimeout,
    TIMEOUTS,
  };
}

/**
 * Specific timeout helpers for common operations
 */
export const useProjectIPC = () => {
  const { callWithTimeout } = useIPCWithTimeout();

  return {
    loadProject: (path: string) =>
      callWithTimeout(
        () => window.electron.project.load(path),
        'project:load',
        TIMEOUTS.MEDIUM
      ),

    createProject: (data: any) =>
      callWithTimeout(
        () => window.electron.project.create(data),
        'project:create',
        TIMEOUTS.FAST
      ),

    closeProject: () =>
      callWithTimeout(
        () => window.electron.project.close(),
        'project:close',
        TIMEOUTS.FAST
      ),
  };
};

export const usePDFIPC = () => {
  const { callWithTimeout } = useIPCWithTimeout();

  return {
    indexPDF: (filePath: string, bibtexKey?: string) =>
      callWithTimeout(
        () => window.electron.pdf.index(filePath, bibtexKey),
        'pdf:index',
        TIMEOUTS.VERY_SLOW // PDF indexing can be slow
      ),

    searchPDF: (query: string, options?: any) =>
      callWithTimeout(
        () => window.electron.pdf.search(query, options),
        'pdf:search',
        TIMEOUTS.MEDIUM
      ),

    getAllPDFs: () =>
      callWithTimeout(
        () => window.electron.pdf.getAll(),
        'pdf:get-all',
        TIMEOUTS.MEDIUM
      ),
  };
};

export const useChatIPC = () => {
  const { callWithTimeout } = useIPCWithTimeout();

  return {
    sendMessage: (message: string, options?: any) =>
      callWithTimeout(
        () => window.electron.chat.send(message, options),
        'chat:send',
        TIMEOUTS.SLOW // RAG queries can be slow
      ),

    cancelMessage: () =>
      callWithTimeout(
        () => window.electron.chat.cancel(),
        'chat:cancel',
        TIMEOUTS.FAST
      ),
  };
};

export const useCorpusIPC = () => {
  const { callWithTimeout } = useIPCWithTimeout();

  return {
    getGraph: (options?: any) =>
      callWithTimeout(
        () => window.electron.corpus.getGraph(options),
        'corpus:get-graph',
        TIMEOUTS.SLOW
      ),

    analyzeTopics: (options?: any) =>
      callWithTimeout(
        () => window.electron.corpus.analyzeTopics(options),
        'corpus:analyze-topics',
        TIMEOUTS.VERY_SLOW // Topic modeling is very slow
      ),

    getStatistics: () =>
      callWithTimeout(
        () => window.electron.corpus.getStatistics(),
        'corpus:get-statistics',
        TIMEOUTS.MEDIUM
      ),
  };
};
