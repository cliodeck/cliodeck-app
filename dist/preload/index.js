"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
// API exposée au renderer process
const api = {
    // Projects
    project: {
        create: (data) => electron_1.ipcRenderer.invoke('project:create', data),
        load: (path) => electron_1.ipcRenderer.invoke('project:load', path),
        getMetadata: (path) => electron_1.ipcRenderer.invoke('project:get-metadata', path),
        close: () => electron_1.ipcRenderer.invoke('project:close'),
        save: (data) => electron_1.ipcRenderer.invoke('project:save', data),
        getRecent: () => electron_1.ipcRenderer.invoke('project:get-recent'),
        removeRecent: (path) => electron_1.ipcRenderer.invoke('project:remove-recent', path),
        getChapters: (projectId) => electron_1.ipcRenderer.invoke('project:get-chapters', projectId),
        setBibliographySource: (data) => electron_1.ipcRenderer.invoke('project:set-bibliography-source', data),
        setCSLPath: (data) => electron_1.ipcRenderer.invoke('project:set-csl-path', data),
        getConfig: (projectPath) => electron_1.ipcRenderer.invoke('project:get-config', projectPath),
        updateConfig: (projectPath, updates) => electron_1.ipcRenderer.invoke('project:update-config', projectPath, updates),
        onRebuildProgress: (callback) => {
            electron_1.ipcRenderer.on('project:rebuild-progress', (_event, progress) => callback(progress));
        },
    },
    // PDF & Documents
    pdf: {
        extractMetadata: (filePath) => electron_1.ipcRenderer.invoke('pdf:extractMetadata', filePath),
        index: (filePath, bibtexKey, bibliographyMetadata) => electron_1.ipcRenderer.invoke('pdf:index', filePath, bibtexKey, bibliographyMetadata),
        search: (query, options) => electron_1.ipcRenderer.invoke('pdf:search', query, options),
        delete: (documentId) => electron_1.ipcRenderer.invoke('pdf:delete', documentId),
        getAll: () => electron_1.ipcRenderer.invoke('pdf:get-all'),
        getDocument: (documentId) => electron_1.ipcRenderer.invoke('pdf:get-document', documentId),
        getStatistics: () => electron_1.ipcRenderer.invoke('pdf:get-statistics'),
        purge: () => electron_1.ipcRenderer.invoke('pdf:purge'),
        cleanOrphanedChunks: () => electron_1.ipcRenderer.invoke('pdf:clean-orphaned-chunks'),
        checkModifiedPDFs: (options) => electron_1.ipcRenderer.invoke('pdf:check-modified-pdfs', options),
        onIndexingProgress: (callback) => {
            const listener = (_event, progress) => callback(progress);
            electron_1.ipcRenderer.on('pdf:indexing-progress', listener);
            return () => electron_1.ipcRenderer.removeListener('pdf:indexing-progress', listener);
        },
    },
    // Chat RAG
    chat: {
        send: (message, options) => electron_1.ipcRenderer.invoke('chat:send', message, options),
        onStream: (callback) => {
            electron_1.ipcRenderer.on('chat:stream', (_event, chunk) => callback(chunk));
        },
        cancel: () => electron_1.ipcRenderer.invoke('chat:cancel'),
    },
    // Bibliography
    bibliography: {
        load: (filePath) => electron_1.ipcRenderer.invoke('bibliography:load', filePath),
        loadWithMetadata: (options) => electron_1.ipcRenderer.invoke('bibliography:load-with-metadata', options),
        parse: (content) => electron_1.ipcRenderer.invoke('bibliography:parse', content),
        search: (query) => electron_1.ipcRenderer.invoke('bibliography:search', query),
        getStatistics: (citations) => electron_1.ipcRenderer.invoke('bibliography:get-statistics', citations),
        export: (options) => electron_1.ipcRenderer.invoke('bibliography:export', options),
        exportString: (options) => electron_1.ipcRenderer.invoke('bibliography:export-string', options),
        detectOrphanPDFs: (options) => electron_1.ipcRenderer.invoke('bibliography:detect-orphan-pdfs', options),
        deleteOrphanPDFs: (filePaths) => electron_1.ipcRenderer.invoke('bibliography:delete-orphan-pdfs', filePaths),
        archiveOrphanPDFs: (options) => electron_1.ipcRenderer.invoke('bibliography:archive-orphan-pdfs', options),
        saveMetadata: (options) => electron_1.ipcRenderer.invoke('bibliography:save-metadata', options),
        loadMetadata: (projectPath) => electron_1.ipcRenderer.invoke('bibliography:load-metadata', projectPath),
    },
    // Editor
    editor: {
        loadFile: (filePath) => electron_1.ipcRenderer.invoke('editor:load-file', filePath),
        saveFile: (filePath, content) => electron_1.ipcRenderer.invoke('editor:save-file', filePath, content),
        insertText: (text, metadata) => electron_1.ipcRenderer.invoke('editor:insert-text', text, metadata),
        onInsertText: (callback) => {
            const listener = (_event, text) => callback(text);
            electron_1.ipcRenderer.on('editor:insert-text-command', listener);
            return () => electron_1.ipcRenderer.removeListener('editor:insert-text-command', listener);
        },
    },
    // Configuration
    config: {
        get: (key) => electron_1.ipcRenderer.invoke('config:get', key),
        set: (key, value) => electron_1.ipcRenderer.invoke('config:set', key, value),
        getAll: () => electron_1.ipcRenderer.invoke('config:get-all'),
    },
    // Ollama
    ollama: {
        listModels: () => electron_1.ipcRenderer.invoke('ollama:list-models'),
        checkAvailability: () => electron_1.ipcRenderer.invoke('ollama:check-availability'),
    },
    // Dialogs
    dialog: {
        openFile: (options) => electron_1.ipcRenderer.invoke('dialog:open-file', options),
        saveFile: (options) => electron_1.ipcRenderer.invoke('dialog:save-file', options),
    },
    // File system
    fs: {
        readDirectory: (dirPath) => electron_1.ipcRenderer.invoke('fs:read-directory', dirPath),
        exists: (filePath) => electron_1.ipcRenderer.invoke('fs:exists', filePath),
        readFile: (filePath) => electron_1.ipcRenderer.invoke('fs:read-file', filePath),
        writeFile: (filePath, content) => electron_1.ipcRenderer.invoke('fs:write-file', filePath, content),
        copyFile: (sourcePath, targetPath) => electron_1.ipcRenderer.invoke('fs:copy-file', sourcePath, targetPath),
    },
    // Zotero
    zotero: {
        testConnection: (userId, apiKey, groupId) => electron_1.ipcRenderer.invoke('zotero:test-connection', userId, apiKey, groupId),
        listCollections: (userId, apiKey, groupId) => electron_1.ipcRenderer.invoke('zotero:list-collections', userId, apiKey, groupId),
        sync: (options) => electron_1.ipcRenderer.invoke('zotero:sync', options),
        downloadPDF: (options) => electron_1.ipcRenderer.invoke('zotero:download-pdf', options),
        checkUpdates: (options) => electron_1.ipcRenderer.invoke('zotero:check-updates', options),
        applyUpdates: (options) => electron_1.ipcRenderer.invoke('zotero:apply-updates', options),
        enrichCitations: (options) => electron_1.ipcRenderer.invoke('zotero:enrich-citations', options),
    },
    // PDF Export
    pdfExport: {
        checkDependencies: () => electron_1.ipcRenderer.invoke('pdf-export:check-dependencies'),
        export: (options) => electron_1.ipcRenderer.invoke('pdf-export:export', options),
        onProgress: (callback) => {
            const listener = (_event, progress) => callback(progress);
            electron_1.ipcRenderer.on('pdf-export:progress', listener);
            return () => electron_1.ipcRenderer.removeListener('pdf-export:progress', listener);
        },
    },
    // Word Export
    wordExport: {
        export: (options) => electron_1.ipcRenderer.invoke('word-export:export', options),
        onProgress: (callback) => {
            const listener = (_event, progress) => callback(progress);
            electron_1.ipcRenderer.on('word-export:progress', listener);
            return () => electron_1.ipcRenderer.removeListener('word-export:progress', listener);
        },
        findTemplate: (projectPath) => electron_1.ipcRenderer.invoke('word-export:find-template', projectPath),
    },
    // Reveal.js Export
    revealJsExport: {
        export: (options) => electron_1.ipcRenderer.invoke('revealjs-export:export', options),
        onProgress: (callback) => {
            const listener = (_event, progress) => callback(progress);
            electron_1.ipcRenderer.on('revealjs-export:progress', listener);
            return () => electron_1.ipcRenderer.removeListener('revealjs-export:progress', listener);
        },
    },
    // Corpus Explorer
    corpus: {
        getGraph: (options) => electron_1.ipcRenderer.invoke('corpus:get-graph', options),
        getStatistics: () => electron_1.ipcRenderer.invoke('corpus:get-statistics'),
        analyzeTopics: (options) => electron_1.ipcRenderer.invoke('corpus:analyze-topics', options),
        loadTopics: () => electron_1.ipcRenderer.invoke('corpus:load-topics'),
        getTopicTimeline: () => electron_1.ipcRenderer.invoke('corpus:get-topic-timeline'),
        getTextStatistics: (options) => electron_1.ipcRenderer.invoke('corpus:get-text-statistics', options),
        getCollections: () => electron_1.ipcRenderer.invoke('corpus:get-collections'),
    },
    // Topic Modeling Environment
    topicModeling: {
        checkStatus: () => electron_1.ipcRenderer.invoke('topic-modeling:check-status'),
        setupEnvironment: () => electron_1.ipcRenderer.invoke('topic-modeling:setup-environment'),
        onSetupProgress: (callback) => {
            const listener = (_event, message) => callback(message);
            electron_1.ipcRenderer.on('topic-modeling:setup-progress', listener);
            return () => electron_1.ipcRenderer.removeListener('topic-modeling:setup-progress', listener);
        },
    },
    // Embedded LLM Management
    embeddedLLM: {
        /** Check if a model is downloaded */
        isDownloaded: (modelId) => electron_1.ipcRenderer.invoke('embedded-llm:is-downloaded', modelId),
        /** Get the path to a model (if downloaded) */
        getModelPath: (modelId) => electron_1.ipcRenderer.invoke('embedded-llm:get-model-path', modelId),
        /** List all available models with their download status */
        listModels: () => electron_1.ipcRenderer.invoke('embedded-llm:list-models'),
        /** Get info about a specific model */
        getModelInfo: (modelId) => electron_1.ipcRenderer.invoke('embedded-llm:get-model-info', modelId),
        /** Download a model from HuggingFace */
        download: (modelId) => electron_1.ipcRenderer.invoke('embedded-llm:download', modelId),
        /** Cancel an ongoing download */
        cancelDownload: () => electron_1.ipcRenderer.invoke('embedded-llm:cancel-download'),
        /** Delete a downloaded model */
        deleteModel: (modelId) => electron_1.ipcRenderer.invoke('embedded-llm:delete-model', modelId),
        /** Get disk space used by downloaded models */
        getUsedSpace: () => electron_1.ipcRenderer.invoke('embedded-llm:get-used-space'),
        /** Get the models directory path */
        getModelsDirectory: () => electron_1.ipcRenderer.invoke('embedded-llm:get-models-directory'),
        /** Check if a download is in progress */
        isDownloading: () => electron_1.ipcRenderer.invoke('embedded-llm:is-downloading'),
        /** Set the preferred LLM provider */
        setProvider: (provider) => electron_1.ipcRenderer.invoke('embedded-llm:set-provider', provider),
        /** Get the current LLM provider setting */
        getProvider: () => electron_1.ipcRenderer.invoke('embedded-llm:get-provider'),
        /** Listen for download progress updates */
        onDownloadProgress: (callback) => {
            const listener = (_event, progress) => callback(progress);
            electron_1.ipcRenderer.on('embedded-llm:download-progress', listener);
            return () => electron_1.ipcRenderer.removeListener('embedded-llm:download-progress', listener);
        },
    },
    // History / Journal
    history: {
        getSessions: () => electron_1.ipcRenderer.invoke('history:get-sessions'),
        getEvents: (sessionId) => electron_1.ipcRenderer.invoke('history:get-events', sessionId),
        getChatHistory: (sessionId) => electron_1.ipcRenderer.invoke('history:get-chat-history', sessionId),
        getAIOperations: (sessionId) => electron_1.ipcRenderer.invoke('history:get-ai-operations', sessionId),
        exportReport: (sessionId, format) => electron_1.ipcRenderer.invoke('history:export-report', sessionId, format),
        getStatistics: () => electron_1.ipcRenderer.invoke('history:get-statistics'),
        searchEvents: (filters) => electron_1.ipcRenderer.invoke('history:search-events', filters),
        // Project-wide data (all sessions)
        getAllEvents: () => electron_1.ipcRenderer.invoke('history:get-all-events'),
        getAllAIOperations: () => electron_1.ipcRenderer.invoke('history:get-all-ai-operations'),
        getAllChatMessages: () => electron_1.ipcRenderer.invoke('history:get-all-chat-messages'),
    },
    // Modes
    mode: {
        getAll: () => electron_1.ipcRenderer.invoke('mode:get-all'),
        get: (modeId) => electron_1.ipcRenderer.invoke('mode:get', modeId),
        getActive: () => electron_1.ipcRenderer.invoke('mode:get-active'),
        setActive: (modeId) => electron_1.ipcRenderer.invoke('mode:set-active', modeId),
        save: (mode, target) => electron_1.ipcRenderer.invoke('mode:save', mode, target),
        delete: (modeId, source) => electron_1.ipcRenderer.invoke('mode:delete', modeId, source),
        import: (filePath, target) => electron_1.ipcRenderer.invoke('mode:import', filePath, target),
        export: (modeId, outputPath) => electron_1.ipcRenderer.invoke('mode:export', modeId, outputPath),
    },
    // IPC Renderer for menu shortcuts
    ipcRenderer: {
        on: (channel, listener) => {
            electron_1.ipcRenderer.on(channel, listener);
        },
        removeListener: (channel, listener) => {
            electron_1.ipcRenderer.removeListener(channel, listener);
        },
        send: (channel, ...args) => {
            electron_1.ipcRenderer.send(channel, ...args);
        },
    },
    // Shell
    shell: {
        openExternal: (url) => electron_1.ipcRenderer.invoke('shell:open-external', url),
        openPath: (path) => electron_1.ipcRenderer.invoke('shell:open-path', path),
    },
    // Tropy (Primary Sources)
    tropy: {
        // Project Management
        openProject: (tpyPath) => electron_1.ipcRenderer.invoke('tropy:open-project', tpyPath),
        getProjectInfo: () => electron_1.ipcRenderer.invoke('tropy:get-project-info'),
        // Synchronization
        sync: (options) => electron_1.ipcRenderer.invoke('tropy:sync', options),
        checkSyncNeeded: () => electron_1.ipcRenderer.invoke('tropy:check-sync-needed'),
        // File Watching
        startWatching: (tpyPath) => electron_1.ipcRenderer.invoke('tropy:start-watching', tpyPath),
        stopWatching: () => electron_1.ipcRenderer.invoke('tropy:stop-watching'),
        isWatching: () => electron_1.ipcRenderer.invoke('tropy:is-watching'),
        // OCR
        performOCR: (imagePath, language) => electron_1.ipcRenderer.invoke('tropy:perform-ocr', imagePath, language),
        performBatchOCR: (imagePaths, language) => electron_1.ipcRenderer.invoke('tropy:perform-batch-ocr', imagePaths, language),
        getOCRLanguages: () => electron_1.ipcRenderer.invoke('tropy:get-ocr-languages'),
        // Transcription Import
        importTranscription: (filePath, type) => electron_1.ipcRenderer.invoke('tropy:import-transcription', filePath, type),
        // Sources
        getAllSources: () => electron_1.ipcRenderer.invoke('tropy:get-all-sources'),
        getSource: (sourceId) => electron_1.ipcRenderer.invoke('tropy:get-source', sourceId),
        updateTranscription: (sourceId, transcription, source) => electron_1.ipcRenderer.invoke('tropy:update-transcription', sourceId, transcription, source),
        // Statistics
        getStatistics: () => electron_1.ipcRenderer.invoke('tropy:get-statistics'),
        getAllTags: () => electron_1.ipcRenderer.invoke('tropy:get-all-tags'),
        // Database Management
        purge: () => electron_1.ipcRenderer.invoke('tropy:purge'),
        // Events
        onFileChanged: (callback) => {
            const listener = (_event, tpyPath) => callback(tpyPath);
            electron_1.ipcRenderer.on('tropy:file-changed', listener);
            return () => electron_1.ipcRenderer.removeListener('tropy:file-changed', listener);
        },
        onSyncProgress: (callback) => {
            const listener = (_event, progress) => callback(progress);
            electron_1.ipcRenderer.on('tropy:sync-progress', listener);
            return () => electron_1.ipcRenderer.removeListener('tropy:sync-progress', listener);
        },
        onWatcherError: (callback) => {
            const listener = (_event, error) => callback(error);
            electron_1.ipcRenderer.on('tropy:watcher-error', listener);
            return () => electron_1.ipcRenderer.removeListener('tropy:watcher-error', listener);
        },
    },
    // Similarity Finder
    similarity: {
        analyze: (text, options) => electron_1.ipcRenderer.invoke('similarity:analyze', text, options),
        cancel: () => electron_1.ipcRenderer.invoke('similarity:cancel'),
        getSegmentResults: (segmentId) => electron_1.ipcRenderer.invoke('similarity:get-segment-results', segmentId),
        getAllResults: () => electron_1.ipcRenderer.invoke('similarity:get-all-results'),
        clearCache: () => electron_1.ipcRenderer.invoke('similarity:clear-cache'),
        onProgress: (callback) => {
            const listener = (_event, progress) => callback(progress);
            electron_1.ipcRenderer.on('similarity:progress', listener);
            return () => electron_1.ipcRenderer.removeListener('similarity:progress', listener);
        },
    },
};
// Exposer l'API au renderer via window.electron
electron_1.contextBridge.exposeInMainWorld('electron', api);
