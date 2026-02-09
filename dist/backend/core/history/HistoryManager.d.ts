export interface Session {
    id: string;
    projectPath: string;
    startedAt: Date;
    endedAt?: Date;
    totalDurationMs?: number;
    eventCount: number;
    metadata?: Record<string, any>;
}
export interface HistoryEvent {
    id: string;
    sessionId: string;
    eventType: string;
    timestamp: Date;
    eventData?: Record<string, any>;
}
export interface AIOperation {
    id: string;
    sessionId: string;
    operationType: 'rag_query' | 'summarization' | 'citation_extraction' | 'topic_modeling';
    timestamp: Date;
    durationMs?: number;
    inputText?: string;
    inputMetadata?: Record<string, any>;
    modelName?: string;
    modelParameters?: Record<string, any>;
    outputText?: string;
    outputMetadata?: Record<string, any>;
    success: boolean;
    errorMessage?: string;
}
export interface DocumentOperation {
    id: string;
    sessionId: string;
    operationType: 'save' | 'create' | 'delete';
    filePath: string;
    timestamp: Date;
    wordsAdded?: number;
    wordsDeleted?: number;
    charactersAdded?: number;
    charactersDeleted?: number;
    contentHash?: string;
}
export interface PDFOperation {
    id: string;
    sessionId: string;
    operationType: 'import' | 'delete' | 'reindex';
    documentId?: string;
    timestamp: Date;
    durationMs?: number;
    filePath?: string;
    pageCount?: number;
    chunksCreated?: number;
    citationsExtracted?: number;
    metadata?: Record<string, any>;
}
export interface ChatMessage {
    id: string;
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    sources?: any[];
    timestamp: Date;
    modeId?: string;
}
export interface HistoryStatistics {
    totalSessions: number;
    totalEvents: number;
    totalChatMessages: number;
    totalAIOperations: number;
    averageSessionDuration: number;
}
export declare class HistoryManager {
    private db;
    private dbPath;
    readonly projectPath: string;
    private currentSessionId;
    private isOpen;
    constructor(projectPath: string);
    private enableForeignKeys;
    private createTables;
    private createIndexes;
    private migrateDatabase;
    startSession(metadata?: Record<string, any>): string;
    endSession(sessionId?: string): void;
    getCurrentSessionId(): string | null;
    logEvent(eventType: string, eventData?: Record<string, any>): string;
    logAIOperation(operation: Omit<AIOperation, 'id' | 'sessionId' | 'timestamp'>): string;
    logDocumentOperation(operation: Omit<DocumentOperation, 'id' | 'sessionId' | 'timestamp'>): string;
    logPDFOperation(operation: Omit<PDFOperation, 'id' | 'sessionId' | 'timestamp'>): string;
    logChatMessage(message: Omit<ChatMessage, 'id' | 'sessionId' | 'timestamp'> & {
        modeId?: string;
        queryParams?: any;
    }): string;
    getSession(sessionId: string): Session | null;
    getAllSessions(): Session[];
    getEventsForSession(sessionId: string): HistoryEvent[];
    getChatMessagesForSession(sessionId: string): ChatMessage[];
    getAIOperationsForSession(sessionId: string): AIOperation[];
    getDocumentOperationsForSession(sessionId: string): DocumentOperation[];
    getPDFOperationsForSession(sessionId: string): PDFOperation[];
    getAllEvents(): HistoryEvent[];
    getAllAIOperations(): AIOperation[];
    getAllChatMessages(): ChatMessage[];
    getAllDocumentOperations(): DocumentOperation[];
    getAllPDFOperations(): PDFOperation[];
    private parseAIOperation;
    searchEvents(filters: {
        sessionId?: string;
        eventType?: string;
        startDate?: Date;
        endDate?: Date;
        limit?: number;
    }): HistoryEvent[];
    exportSessionReport(sessionId: string, format: 'markdown' | 'json' | 'latex'): string;
    private exportAsMarkdown;
    private exportAsLaTeX;
    getStatistics(): HistoryStatistics;
    /**
     * Check if the database connection is still open
     */
    isDatabaseOpen(): boolean;
    close(): void;
}
