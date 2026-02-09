import { HistoryManager } from '../../../backend/core/history/HistoryManager.js';
/**
 * History Service
 *
 * Manages the HistoryManager instance for the current project.
 * Automatically starts/ends sessions on project load/close.
 */
declare class HistoryService {
    private historyManager;
    private currentProjectPath;
    /**
     * Initialize history service for a project
     * Auto-starts a new session with metadata
     */
    init(projectPath: string): Promise<void>;
    /**
     * Get the current HistoryManager instance
     */
    getHistoryManager(): HistoryManager | null;
    /**
     * Close history service
     * Ends current session and closes database
     */
    close(): void;
    /**
     * Check if history service is initialized
     */
    isInitialized(): boolean;
    /**
     * Get current project path
     */
    getCurrentProjectPath(): string | null;
}
export declare const historyService: HistoryService;
export {};
