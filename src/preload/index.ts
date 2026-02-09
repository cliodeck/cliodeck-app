import { contextBridge, ipcRenderer } from 'electron';

// API exposée au renderer process
const api = {
  // Projects
  project: {
    create: (data: any) => ipcRenderer.invoke('project:create', data),
    load: (path: string) => ipcRenderer.invoke('project:load', path),
    getMetadata: (path: string) => ipcRenderer.invoke('project:get-metadata', path),
    close: () => ipcRenderer.invoke('project:close'),
    save: (data: any) => ipcRenderer.invoke('project:save', data),
    getRecent: () => ipcRenderer.invoke('project:get-recent'),
    removeRecent: (path: string) => ipcRenderer.invoke('project:remove-recent', path),
    getChapters: (projectId: string) => ipcRenderer.invoke('project:get-chapters', projectId),
    setBibliographySource: (data: {
      projectPath: string;
      type: 'file' | 'zotero';
      filePath?: string;
      zoteroCollection?: string;
    }) => ipcRenderer.invoke('project:set-bibliography-source', data),
    setCSLPath: (data: {
      projectPath: string;
      cslPath?: string;
    }) => ipcRenderer.invoke('project:set-csl-path', data),
    getConfig: (projectPath: string) => ipcRenderer.invoke('project:get-config', projectPath),
    updateConfig: (projectPath: string, updates: any) => ipcRenderer.invoke('project:update-config', projectPath, updates),
    onRebuildProgress: (callback: (progress: {
      current: number;
      total: number;
      status: string;
      percentage: number;
    }) => void) => {
      ipcRenderer.on('project:rebuild-progress', (_event, progress) => callback(progress));
    },
  },

  // PDF & Documents
  pdf: {
    extractMetadata: (filePath: string) =>
      ipcRenderer.invoke('pdf:extractMetadata', filePath),
    index: (filePath: string, bibtexKey?: string, bibliographyMetadata?: { title?: string; author?: string; year?: string }) =>
      ipcRenderer.invoke('pdf:index', filePath, bibtexKey, bibliographyMetadata),
    search: (query: string, options?: any) =>
      ipcRenderer.invoke('pdf:search', query, options),
    delete: (documentId: string) =>
      ipcRenderer.invoke('pdf:delete', documentId),
    getAll: () => ipcRenderer.invoke('pdf:get-all'),
    getDocument: (documentId: string) => ipcRenderer.invoke('pdf:get-document', documentId),
    getStatistics: () => ipcRenderer.invoke('pdf:get-statistics'),
    purge: () => ipcRenderer.invoke('pdf:purge'),
    cleanOrphanedChunks: () => ipcRenderer.invoke('pdf:clean-orphaned-chunks'),
    checkModifiedPDFs: (options: {
      citations: any[];
      projectPath: string;
    }) => ipcRenderer.invoke('pdf:check-modified-pdfs', options),
    onIndexingProgress: (callback: (progress: { stage: string; progress: number; message: string }) => void) => {
      const listener = (_event: any, progress: any) => callback(progress);
      ipcRenderer.on('pdf:indexing-progress', listener);
      return () => ipcRenderer.removeListener('pdf:indexing-progress', listener);
    },
  },

  // Chat RAG
  chat: {
    send: (message: string, options?: any) =>
      ipcRenderer.invoke('chat:send', message, options),
    onStream: (callback: (chunk: string) => void) => {
      ipcRenderer.on('chat:stream', (_event, chunk) => callback(chunk));
    },
    cancel: () => ipcRenderer.invoke('chat:cancel'),
  },

  // Bibliography
  bibliography: {
    load: (filePath: string) => ipcRenderer.invoke('bibliography:load', filePath),
    loadWithMetadata: (options: {
      filePath: string;
      projectPath: string;
    }) => ipcRenderer.invoke('bibliography:load-with-metadata', options),
    parse: (content: string) => ipcRenderer.invoke('bibliography:parse', content),
    search: (query: string) => ipcRenderer.invoke('bibliography:search', query),
    getStatistics: (citations?: any[]) => ipcRenderer.invoke('bibliography:get-statistics', citations),
    export: (options: {
      citations: any[];
      filePath: string;
      format?: 'modern' | 'legacy';
    }) => ipcRenderer.invoke('bibliography:export', options),
    exportString: (options: {
      citations: any[];
      format?: 'modern' | 'legacy';
    }) => ipcRenderer.invoke('bibliography:export-string', options),
    detectOrphanPDFs: (options: {
      projectPath: string;
      citations: any[];
      includeSubdirectories?: boolean;
      pdfSubdirectory?: string;
    }) => ipcRenderer.invoke('bibliography:detect-orphan-pdfs', options),
    deleteOrphanPDFs: (filePaths: string[]) => ipcRenderer.invoke('bibliography:delete-orphan-pdfs', filePaths),
    archiveOrphanPDFs: (options: {
      filePaths: string[];
      projectPath: string;
      archiveSubdir?: string;
    }) => ipcRenderer.invoke('bibliography:archive-orphan-pdfs', options),
    saveMetadata: (options: {
      projectPath: string;
      citations: any[];
    }) => ipcRenderer.invoke('bibliography:save-metadata', options),
    loadMetadata: (projectPath: string) => ipcRenderer.invoke('bibliography:load-metadata', projectPath),
  },

  // Editor
  editor: {
    loadFile: (filePath: string) => ipcRenderer.invoke('editor:load-file', filePath),
    saveFile: (filePath: string, content: string) =>
      ipcRenderer.invoke('editor:save-file', filePath, content),
    insertText: (text: string, metadata?: { modeId?: string; model?: string }) =>
      ipcRenderer.invoke('editor:insert-text', text, metadata),
    onInsertText: (callback: (text: string) => void) => {
      const listener = (_event: any, text: string) => callback(text);
      ipcRenderer.on('editor:insert-text-command', listener);
      return () => ipcRenderer.removeListener('editor:insert-text-command', listener);
    },
  },

  // Configuration
  config: {
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
    getAll: () => ipcRenderer.invoke('config:get-all'),
  },

  // Ollama
  ollama: {
    listModels: () => ipcRenderer.invoke('ollama:list-models'),
    checkAvailability: () => ipcRenderer.invoke('ollama:check-availability'),
  },

  // Dialogs
  dialog: {
    openFile: (options: any) => ipcRenderer.invoke('dialog:open-file', options),
    saveFile: (options: any) => ipcRenderer.invoke('dialog:save-file', options),
  },

  // File system
  fs: {
    readDirectory: (dirPath: string) => ipcRenderer.invoke('fs:read-directory', dirPath),
    exists: (filePath: string) => ipcRenderer.invoke('fs:exists', filePath),
    readFile: (filePath: string) => ipcRenderer.invoke('fs:read-file', filePath),
    writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:write-file', filePath, content),
    copyFile: (sourcePath: string, targetPath: string) => ipcRenderer.invoke('fs:copy-file', sourcePath, targetPath),
  },

  // Zotero
  zotero: {
    testConnection: (userId: string, apiKey: string, groupId?: string) =>
      ipcRenderer.invoke('zotero:test-connection', userId, apiKey, groupId),
    listCollections: (userId: string, apiKey: string, groupId?: string) =>
      ipcRenderer.invoke('zotero:list-collections', userId, apiKey, groupId),
    sync: (options: {
      userId: string;
      apiKey: string;
      groupId?: string;
      collectionKey?: string;
      downloadPDFs: boolean;
      exportBibTeX: boolean;
      targetDirectory?: string;
    }) => ipcRenderer.invoke('zotero:sync', options),
    downloadPDF: (options: {
      userId: string;
      apiKey: string;
      groupId?: string;
      attachmentKey: string;
      filename: string;
      targetDirectory: string;
    }) => ipcRenderer.invoke('zotero:download-pdf', options),
    checkUpdates: (options: {
      userId: string;
      apiKey: string;
      groupId?: string;
      localCitations: any[];
      collectionKey?: string;
    }) => ipcRenderer.invoke('zotero:check-updates', options),
    applyUpdates: (options: {
      userId: string;
      apiKey: string;
      groupId?: string;
      currentCitations: any[];
      diff: any;
      strategy: 'local' | 'remote' | 'manual';
      resolution?: any;
    }) => ipcRenderer.invoke('zotero:apply-updates', options),
    enrichCitations: (options: {
      userId: string;
      apiKey: string;
      groupId?: string;
      citations: any[];
      collectionKey?: string;
    }) => ipcRenderer.invoke('zotero:enrich-citations', options),
  },

  // PDF Export
  pdfExport: {
    checkDependencies: () => ipcRenderer.invoke('pdf-export:check-dependencies'),
    export: (options: {
      projectPath: string;
      projectType: 'article' | 'book' | 'presentation';
      content: string;
      outputPath?: string;
      bibliographyPath?: string;
      metadata?: {
        title?: string;
        author?: string;
        date?: string;
      };
    }) => ipcRenderer.invoke('pdf-export:export', options),
    onProgress: (callback: (progress: any) => void) => {
      const listener = (_event: any, progress: any) => callback(progress);
      ipcRenderer.on('pdf-export:progress', listener);
      return () => ipcRenderer.removeListener('pdf-export:progress', listener);
    },
  },

  // Word Export
  wordExport: {
    export: (options: {
      projectPath: string;
      projectType: 'article' | 'book' | 'presentation';
      content: string;
      outputPath?: string;
      bibliographyPath?: string;
      cslPath?: string;
      templatePath?: string;
      metadata?: {
        title?: string;
        author?: string;
        date?: string;
      };
    }) => ipcRenderer.invoke('word-export:export', options),
    onProgress: (callback: (progress: any) => void) => {
      const listener = (_event: any, progress: any) => callback(progress);
      ipcRenderer.on('word-export:progress', listener);
      return () => ipcRenderer.removeListener('word-export:progress', listener);
    },
    findTemplate: (projectPath: string) => ipcRenderer.invoke('word-export:find-template', projectPath),
  },

  // Reveal.js Export
  revealJsExport: {
    export: (options: {
      projectPath: string;
      content: string;
      outputPath?: string;
      metadata?: {
        title?: string;
        author?: string;
        date?: string;
      };
      config?: any;
    }) => ipcRenderer.invoke('revealjs-export:export', options),
    onProgress: (callback: (progress: any) => void) => {
      const listener = (_event: any, progress: any) => callback(progress);
      ipcRenderer.on('revealjs-export:progress', listener);
      return () => ipcRenderer.removeListener('revealjs-export:progress', listener);
    },
  },

  // Corpus Explorer
  corpus: {
    getGraph: (options?: {
      includeSimilarityEdges?: boolean;
      similarityThreshold?: number;
      includeAuthorNodes?: boolean;
      computeLayout?: boolean;
    }) => ipcRenderer.invoke('corpus:get-graph', options),
    getStatistics: () => ipcRenderer.invoke('corpus:get-statistics'),
    analyzeTopics: (options?: {
      minTopicSize?: number;
      language?: string;
      nGramRange?: [number, number];
      nrTopics?: number;
    }) => ipcRenderer.invoke('corpus:analyze-topics', options),
    loadTopics: () => ipcRenderer.invoke('corpus:load-topics'),
    getTopicTimeline: () => ipcRenderer.invoke('corpus:get-topic-timeline'),
    getTextStatistics: (options?: {
      topN?: number;
    }) => ipcRenderer.invoke('corpus:get-text-statistics', options),
    getCollections: () => ipcRenderer.invoke('corpus:get-collections'),
  },

  // Topic Modeling Environment
  topicModeling: {
    checkStatus: () => ipcRenderer.invoke('topic-modeling:check-status'),
    setupEnvironment: () => ipcRenderer.invoke('topic-modeling:setup-environment'),
    onSetupProgress: (callback: (message: string) => void) => {
      const listener = (_event: any, message: string) => callback(message);
      ipcRenderer.on('topic-modeling:setup-progress', listener);
      return () => ipcRenderer.removeListener('topic-modeling:setup-progress', listener);
    },
  },

  // Embedded LLM Management
  embeddedLLM: {
    /** Check if a model is downloaded */
    isDownloaded: (modelId?: string) =>
      ipcRenderer.invoke('embedded-llm:is-downloaded', modelId),
    /** Get the path to a model (if downloaded) */
    getModelPath: (modelId?: string) =>
      ipcRenderer.invoke('embedded-llm:get-model-path', modelId),
    /** List all available models with their download status */
    listModels: () => ipcRenderer.invoke('embedded-llm:list-models'),
    /** Get info about a specific model */
    getModelInfo: (modelId?: string) =>
      ipcRenderer.invoke('embedded-llm:get-model-info', modelId),
    /** Download a model from HuggingFace */
    download: (modelId?: string) =>
      ipcRenderer.invoke('embedded-llm:download', modelId),
    /** Cancel an ongoing download */
    cancelDownload: () => ipcRenderer.invoke('embedded-llm:cancel-download'),
    /** Delete a downloaded model */
    deleteModel: (modelId?: string) =>
      ipcRenderer.invoke('embedded-llm:delete-model', modelId),
    /** Get disk space used by downloaded models */
    getUsedSpace: () => ipcRenderer.invoke('embedded-llm:get-used-space'),
    /** Get the models directory path */
    getModelsDirectory: () => ipcRenderer.invoke('embedded-llm:get-models-directory'),
    /** Check if a download is in progress */
    isDownloading: () => ipcRenderer.invoke('embedded-llm:is-downloading'),
    /** Set the preferred LLM provider */
    setProvider: (provider: 'ollama' | 'embedded' | 'auto') =>
      ipcRenderer.invoke('embedded-llm:set-provider', provider),
    /** Get the current LLM provider setting */
    getProvider: () => ipcRenderer.invoke('embedded-llm:get-provider'),
    /** Listen for download progress updates */
    onDownloadProgress: (callback: (progress: {
      percent: number;
      downloadedMB: number;
      totalMB: number;
      speed: string;
      eta: string;
      status: 'pending' | 'downloading' | 'verifying' | 'complete' | 'error' | 'cancelled';
      message: string;
    }) => void) => {
      const listener = (_event: any, progress: any) => callback(progress);
      ipcRenderer.on('embedded-llm:download-progress', listener);
      return () => ipcRenderer.removeListener('embedded-llm:download-progress', listener);
    },
  },

  // History / Journal
  history: {
    getSessions: () => ipcRenderer.invoke('history:get-sessions'),
    getEvents: (sessionId: string) => ipcRenderer.invoke('history:get-events', sessionId),
    getChatHistory: (sessionId: string) =>
      ipcRenderer.invoke('history:get-chat-history', sessionId),
    getAIOperations: (sessionId: string) =>
      ipcRenderer.invoke('history:get-ai-operations', sessionId),
    exportReport: (sessionId: string, format: 'markdown' | 'json' | 'latex') =>
      ipcRenderer.invoke('history:export-report', sessionId, format),
    getStatistics: () => ipcRenderer.invoke('history:get-statistics'),
    searchEvents: (filters: {
      sessionId?: string;
      eventType?: string;
      startDate?: Date;
      endDate?: Date;
      limit?: number;
    }) => ipcRenderer.invoke('history:search-events', filters),
    // Project-wide data (all sessions)
    getAllEvents: () => ipcRenderer.invoke('history:get-all-events'),
    getAllAIOperations: () => ipcRenderer.invoke('history:get-all-ai-operations'),
    getAllChatMessages: () => ipcRenderer.invoke('history:get-all-chat-messages'),
  },

  // Modes
  mode: {
    getAll: () => ipcRenderer.invoke('mode:get-all'),
    get: (modeId: string) => ipcRenderer.invoke('mode:get', modeId),
    getActive: () => ipcRenderer.invoke('mode:get-active'),
    setActive: (modeId: string) => ipcRenderer.invoke('mode:set-active', modeId),
    save: (mode: any, target: 'global' | 'project') =>
      ipcRenderer.invoke('mode:save', mode, target),
    delete: (modeId: string, source: 'global' | 'project') =>
      ipcRenderer.invoke('mode:delete', modeId, source),
    import: (filePath: string, target: 'global' | 'project') =>
      ipcRenderer.invoke('mode:import', filePath, target),
    export: (modeId: string, outputPath: string) =>
      ipcRenderer.invoke('mode:export', modeId, outputPath),
  },

  // IPC Renderer for menu shortcuts
  ipcRenderer: {
    on: (channel: string, listener: (...args: any[]) => void) => {
      ipcRenderer.on(channel, listener);
    },
    removeListener: (channel: string, listener: (...args: any[]) => void) => {
      ipcRenderer.removeListener(channel, listener);
    },
    send: (channel: string, ...args: any[]) => {
      ipcRenderer.send(channel, ...args);
    },
  },

  // Shell
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
    openPath: (path: string) => ipcRenderer.invoke('shell:open-path', path),
  },

  // Tropy (Primary Sources)
  tropy: {
    // Project Management
    openProject: (tpyPath: string) => ipcRenderer.invoke('tropy:open-project', tpyPath),
    getProjectInfo: () => ipcRenderer.invoke('tropy:get-project-info'),

    // Synchronization
    sync: (options: {
      performOCR: boolean;
      ocrLanguage: string;
      transcriptionDirectory?: string;
      forceReindex?: boolean;
    }) => ipcRenderer.invoke('tropy:sync', options),
    checkSyncNeeded: () => ipcRenderer.invoke('tropy:check-sync-needed'),

    // File Watching
    startWatching: (tpyPath?: string) => ipcRenderer.invoke('tropy:start-watching', tpyPath),
    stopWatching: () => ipcRenderer.invoke('tropy:stop-watching'),
    isWatching: () => ipcRenderer.invoke('tropy:is-watching'),

    // OCR
    performOCR: (imagePath: string, language: string) =>
      ipcRenderer.invoke('tropy:perform-ocr', imagePath, language),
    performBatchOCR: (imagePaths: string[], language: string) =>
      ipcRenderer.invoke('tropy:perform-batch-ocr', imagePaths, language),
    getOCRLanguages: () => ipcRenderer.invoke('tropy:get-ocr-languages'),

    // Transcription Import
    importTranscription: (filePath: string, type?: string) =>
      ipcRenderer.invoke('tropy:import-transcription', filePath, type),

    // Sources
    getAllSources: () => ipcRenderer.invoke('tropy:get-all-sources'),
    getSource: (sourceId: string) => ipcRenderer.invoke('tropy:get-source', sourceId),
    updateTranscription: (
      sourceId: string,
      transcription: string,
      source: 'tesseract' | 'transkribus' | 'manual'
    ) => ipcRenderer.invoke('tropy:update-transcription', sourceId, transcription, source),

    // Statistics
    getStatistics: () => ipcRenderer.invoke('tropy:get-statistics'),
    getAllTags: () => ipcRenderer.invoke('tropy:get-all-tags'),

    // Database Management
    purge: () => ipcRenderer.invoke('tropy:purge'),

    // Events
    onFileChanged: (callback: (tpyPath: string) => void) => {
      const listener = (_event: any, tpyPath: string) => callback(tpyPath);
      ipcRenderer.on('tropy:file-changed', listener);
      return () => ipcRenderer.removeListener('tropy:file-changed', listener);
    },
    onSyncProgress: (callback: (progress: {
      phase: 'reading' | 'processing' | 'extracting-entities' | 'indexing' | 'done';
      current: number;
      total: number;
      currentItem?: string;
    }) => void) => {
      const listener = (_event: any, progress: any) => callback(progress);
      ipcRenderer.on('tropy:sync-progress', listener);
      return () => ipcRenderer.removeListener('tropy:sync-progress', listener);
    },
    onWatcherError: (callback: (error: string) => void) => {
      const listener = (_event: any, error: string) => callback(error);
      ipcRenderer.on('tropy:watcher-error', listener);
      return () => ipcRenderer.removeListener('tropy:watcher-error', listener);
    },
  },

  // Similarity Finder
  similarity: {
    analyze: (text: string, options?: {
      granularity?: 'section' | 'paragraph' | 'sentence';
      maxResults?: number;
      similarityThreshold?: number;
      collectionFilter?: string[] | null;
      useReranking?: boolean;
      useContextualEmbedding?: boolean;
    }) => ipcRenderer.invoke('similarity:analyze', text, options),
    cancel: () => ipcRenderer.invoke('similarity:cancel'),
    getSegmentResults: (segmentId: string) =>
      ipcRenderer.invoke('similarity:get-segment-results', segmentId),
    getAllResults: () => ipcRenderer.invoke('similarity:get-all-results'),
    clearCache: () => ipcRenderer.invoke('similarity:clear-cache'),
    onProgress: (callback: (progress: {
      current: number;
      total: number;
      status: string;
      percentage: number;
      currentSegment?: string;
    }) => void) => {
      const listener = (_event: any, progress: any) => callback(progress);
      ipcRenderer.on('similarity:progress', listener);
      return () => ipcRenderer.removeListener('similarity:progress', listener);
    },
  },
};

// Exposer l'API au renderer via window.electron
contextBridge.exposeInMainWorld('electron', api);

// Types pour TypeScript
export type ElectronAPI = typeof api;
