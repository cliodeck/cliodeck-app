declare const api: {
    project: {
        create: (data: any) => Promise<any>;
        load: (path: string) => Promise<any>;
        getMetadata: (path: string) => Promise<any>;
        close: () => Promise<any>;
        save: (data: any) => Promise<any>;
        getRecent: () => Promise<any>;
        removeRecent: (path: string) => Promise<any>;
        getChapters: (projectId: string) => Promise<any>;
        setBibliographySource: (data: {
            projectPath: string;
            type: "file" | "zotero";
            filePath?: string;
            zoteroCollection?: string;
        }) => Promise<any>;
        setCSLPath: (data: {
            projectPath: string;
            cslPath?: string;
        }) => Promise<any>;
        getConfig: (projectPath: string) => Promise<any>;
        updateConfig: (projectPath: string, updates: any) => Promise<any>;
        onRebuildProgress: (callback: (progress: {
            current: number;
            total: number;
            status: string;
            percentage: number;
        }) => void) => void;
    };
    pdf: {
        extractMetadata: (filePath: string) => Promise<any>;
        index: (filePath: string, bibtexKey?: string, bibliographyMetadata?: {
            title?: string;
            author?: string;
            year?: string;
        }) => Promise<any>;
        search: (query: string, options?: any) => Promise<any>;
        delete: (documentId: string) => Promise<any>;
        getAll: () => Promise<any>;
        getDocument: (documentId: string) => Promise<any>;
        getStatistics: () => Promise<any>;
        purge: () => Promise<any>;
        cleanOrphanedChunks: () => Promise<any>;
        checkModifiedPDFs: (options: {
            citations: any[];
            projectPath: string;
        }) => Promise<any>;
        onIndexingProgress: (callback: (progress: {
            stage: string;
            progress: number;
            message: string;
        }) => void) => () => Electron.IpcRenderer;
    };
    chat: {
        send: (message: string, options?: any) => Promise<any>;
        onStream: (callback: (chunk: string) => void) => void;
        cancel: () => Promise<any>;
    };
    bibliography: {
        load: (filePath: string) => Promise<any>;
        loadWithMetadata: (options: {
            filePath: string;
            projectPath: string;
        }) => Promise<any>;
        parse: (content: string) => Promise<any>;
        search: (query: string) => Promise<any>;
        getStatistics: (citations?: any[]) => Promise<any>;
        export: (options: {
            citations: any[];
            filePath: string;
            format?: "modern" | "legacy";
        }) => Promise<any>;
        exportString: (options: {
            citations: any[];
            format?: "modern" | "legacy";
        }) => Promise<any>;
        detectOrphanPDFs: (options: {
            projectPath: string;
            citations: any[];
            includeSubdirectories?: boolean;
            pdfSubdirectory?: string;
        }) => Promise<any>;
        deleteOrphanPDFs: (filePaths: string[]) => Promise<any>;
        archiveOrphanPDFs: (options: {
            filePaths: string[];
            projectPath: string;
            archiveSubdir?: string;
        }) => Promise<any>;
        saveMetadata: (options: {
            projectPath: string;
            citations: any[];
        }) => Promise<any>;
        loadMetadata: (projectPath: string) => Promise<any>;
    };
    editor: {
        loadFile: (filePath: string) => Promise<any>;
        saveFile: (filePath: string, content: string) => Promise<any>;
        insertText: (text: string, metadata?: {
            modeId?: string;
            model?: string;
        }) => Promise<any>;
        onInsertText: (callback: (text: string) => void) => () => Electron.IpcRenderer;
    };
    config: {
        get: (key: string) => Promise<any>;
        set: (key: string, value: any) => Promise<any>;
        getAll: () => Promise<any>;
    };
    ollama: {
        listModels: () => Promise<any>;
        checkAvailability: () => Promise<any>;
    };
    dialog: {
        openFile: (options: any) => Promise<any>;
        saveFile: (options: any) => Promise<any>;
    };
    fs: {
        readDirectory: (dirPath: string) => Promise<any>;
        exists: (filePath: string) => Promise<any>;
        readFile: (filePath: string) => Promise<any>;
        writeFile: (filePath: string, content: string) => Promise<any>;
        copyFile: (sourcePath: string, targetPath: string) => Promise<any>;
    };
    zotero: {
        testConnection: (userId: string, apiKey: string, groupId?: string) => Promise<any>;
        listCollections: (userId: string, apiKey: string, groupId?: string) => Promise<any>;
        sync: (options: {
            userId: string;
            apiKey: string;
            groupId?: string;
            collectionKey?: string;
            downloadPDFs: boolean;
            exportBibTeX: boolean;
            targetDirectory?: string;
        }) => Promise<any>;
        downloadPDF: (options: {
            userId: string;
            apiKey: string;
            groupId?: string;
            attachmentKey: string;
            filename: string;
            targetDirectory: string;
        }) => Promise<any>;
        checkUpdates: (options: {
            userId: string;
            apiKey: string;
            groupId?: string;
            localCitations: any[];
            collectionKey?: string;
        }) => Promise<any>;
        applyUpdates: (options: {
            userId: string;
            apiKey: string;
            groupId?: string;
            currentCitations: any[];
            diff: any;
            strategy: "local" | "remote" | "manual";
            resolution?: any;
        }) => Promise<any>;
        enrichCitations: (options: {
            userId: string;
            apiKey: string;
            groupId?: string;
            citations: any[];
            collectionKey?: string;
        }) => Promise<any>;
    };
    pdfExport: {
        checkDependencies: () => Promise<any>;
        export: (options: {
            projectPath: string;
            projectType: "article" | "book" | "presentation";
            content: string;
            outputPath?: string;
            bibliographyPath?: string;
            metadata?: {
                title?: string;
                author?: string;
                date?: string;
            };
        }) => Promise<any>;
        onProgress: (callback: (progress: any) => void) => () => Electron.IpcRenderer;
    };
    wordExport: {
        export: (options: {
            projectPath: string;
            projectType: "article" | "book" | "presentation";
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
        }) => Promise<any>;
        onProgress: (callback: (progress: any) => void) => () => Electron.IpcRenderer;
        findTemplate: (projectPath: string) => Promise<any>;
    };
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
        }) => Promise<any>;
        onProgress: (callback: (progress: any) => void) => () => Electron.IpcRenderer;
    };
    corpus: {
        getGraph: (options?: {
            includeSimilarityEdges?: boolean;
            similarityThreshold?: number;
            includeAuthorNodes?: boolean;
            computeLayout?: boolean;
        }) => Promise<any>;
        getStatistics: () => Promise<any>;
        analyzeTopics: (options?: {
            minTopicSize?: number;
            language?: string;
            nGramRange?: [number, number];
            nrTopics?: number;
        }) => Promise<any>;
        loadTopics: () => Promise<any>;
        getTopicTimeline: () => Promise<any>;
        getTextStatistics: (options?: {
            topN?: number;
        }) => Promise<any>;
        getCollections: () => Promise<any>;
    };
    topicModeling: {
        checkStatus: () => Promise<any>;
        setupEnvironment: () => Promise<any>;
        onSetupProgress: (callback: (message: string) => void) => () => Electron.IpcRenderer;
    };
    embeddedLLM: {
        /** Check if a model is downloaded */
        isDownloaded: (modelId?: string) => Promise<any>;
        /** Get the path to a model (if downloaded) */
        getModelPath: (modelId?: string) => Promise<any>;
        /** List all available models with their download status */
        listModels: () => Promise<any>;
        /** Get info about a specific model */
        getModelInfo: (modelId?: string) => Promise<any>;
        /** Download a model from HuggingFace */
        download: (modelId?: string) => Promise<any>;
        /** Cancel an ongoing download */
        cancelDownload: () => Promise<any>;
        /** Delete a downloaded model */
        deleteModel: (modelId?: string) => Promise<any>;
        /** Get disk space used by downloaded models */
        getUsedSpace: () => Promise<any>;
        /** Get the models directory path */
        getModelsDirectory: () => Promise<any>;
        /** Check if a download is in progress */
        isDownloading: () => Promise<any>;
        /** Set the preferred LLM provider */
        setProvider: (provider: "ollama" | "embedded" | "auto") => Promise<any>;
        /** Get the current LLM provider setting */
        getProvider: () => Promise<any>;
        /** Listen for download progress updates */
        onDownloadProgress: (callback: (progress: {
            percent: number;
            downloadedMB: number;
            totalMB: number;
            speed: string;
            eta: string;
            status: "pending" | "downloading" | "verifying" | "complete" | "error" | "cancelled";
            message: string;
        }) => void) => () => Electron.IpcRenderer;
    };
    history: {
        getSessions: () => Promise<any>;
        getEvents: (sessionId: string) => Promise<any>;
        getChatHistory: (sessionId: string) => Promise<any>;
        getAIOperations: (sessionId: string) => Promise<any>;
        exportReport: (sessionId: string, format: "markdown" | "json" | "latex") => Promise<any>;
        getStatistics: () => Promise<any>;
        searchEvents: (filters: {
            sessionId?: string;
            eventType?: string;
            startDate?: Date;
            endDate?: Date;
            limit?: number;
        }) => Promise<any>;
        getAllEvents: () => Promise<any>;
        getAllAIOperations: () => Promise<any>;
        getAllChatMessages: () => Promise<any>;
    };
    mode: {
        getAll: () => Promise<any>;
        get: (modeId: string) => Promise<any>;
        getActive: () => Promise<any>;
        setActive: (modeId: string) => Promise<any>;
        save: (mode: any, target: "global" | "project") => Promise<any>;
        delete: (modeId: string, source: "global" | "project") => Promise<any>;
        import: (filePath: string, target: "global" | "project") => Promise<any>;
        export: (modeId: string, outputPath: string) => Promise<any>;
    };
    ipcRenderer: {
        on: (channel: string, listener: (...args: any[]) => void) => void;
        removeListener: (channel: string, listener: (...args: any[]) => void) => void;
        send: (channel: string, ...args: any[]) => void;
    };
    shell: {
        openExternal: (url: string) => Promise<any>;
        openPath: (path: string) => Promise<any>;
    };
    tropy: {
        openProject: (tpyPath: string) => Promise<any>;
        getProjectInfo: () => Promise<any>;
        sync: (options: {
            performOCR: boolean;
            ocrLanguage: string;
            transcriptionDirectory?: string;
            forceReindex?: boolean;
        }) => Promise<any>;
        checkSyncNeeded: () => Promise<any>;
        startWatching: (tpyPath?: string) => Promise<any>;
        stopWatching: () => Promise<any>;
        isWatching: () => Promise<any>;
        performOCR: (imagePath: string, language: string) => Promise<any>;
        performBatchOCR: (imagePaths: string[], language: string) => Promise<any>;
        getOCRLanguages: () => Promise<any>;
        importTranscription: (filePath: string, type?: string) => Promise<any>;
        getAllSources: () => Promise<any>;
        getSource: (sourceId: string) => Promise<any>;
        updateTranscription: (sourceId: string, transcription: string, source: "tesseract" | "transkribus" | "manual") => Promise<any>;
        getStatistics: () => Promise<any>;
        getAllTags: () => Promise<any>;
        purge: () => Promise<any>;
        onFileChanged: (callback: (tpyPath: string) => void) => () => Electron.IpcRenderer;
        onSyncProgress: (callback: (progress: {
            phase: "reading" | "processing" | "extracting-entities" | "indexing" | "done";
            current: number;
            total: number;
            currentItem?: string;
        }) => void) => () => Electron.IpcRenderer;
        onWatcherError: (callback: (error: string) => void) => () => Electron.IpcRenderer;
    };
    similarity: {
        analyze: (text: string, options?: {
            granularity?: "section" | "paragraph" | "sentence";
            maxResults?: number;
            similarityThreshold?: number;
            collectionFilter?: string[] | null;
            useReranking?: boolean;
            useContextualEmbedding?: boolean;
        }) => Promise<any>;
        cancel: () => Promise<any>;
        getSegmentResults: (segmentId: string) => Promise<any>;
        getAllResults: () => Promise<any>;
        clearCache: () => Promise<any>;
        onProgress: (callback: (progress: {
            current: number;
            total: number;
            status: string;
            percentage: number;
            currentSegment?: string;
        }) => void) => () => Electron.IpcRenderer;
    };
};
export type ElectronAPI = typeof api;
export {};
