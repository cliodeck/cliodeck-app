import { HistoryManager } from '../../../backend/core/history/HistoryManager.js';

/**
 * History Service
 *
 * Manages the HistoryManager instance for the current project.
 * Automatically starts/ends sessions on project load/close.
 */
class HistoryService {
  private historyManager: HistoryManager | null = null;
  private currentProjectPath: string | null = null;

  /**
   * Initialize history service for a project
   * Auto-starts a new session with metadata
   */
  async init(projectPath: string): Promise<void> {
    // If already initialized for same project, skip
    if (this.currentProjectPath === projectPath && this.historyManager) {
      console.log('📝 HistoryService already initialized for this project');
      return;
    }

    // Close existing history manager if changing projects
    if (this.historyManager) {
      console.log('📝 Closing previous HistoryManager');
      this.historyManager.close();
    }

    // Create new history manager
    this.historyManager = new HistoryManager(projectPath);
    this.currentProjectPath = projectPath;

    // Auto-start session with metadata
    const metadata = {
      platform: process.platform,
      nodeVersion: process.version,
      electronVersion: process.versions.electron,
      timestamp: new Date().toISOString(),
    };

    this.historyManager.startSession(metadata);
    console.log('✅ HistoryService initialized and session started');
  }

  /**
   * Get the current HistoryManager instance
   */
  getHistoryManager(): HistoryManager | null {
    return this.historyManager;
  }

  /**
   * Close history service
   * Ends current session and closes database
   */
  close(): void {
    if (this.historyManager) {
      const sessionId = this.historyManager.getCurrentSessionId();
      if (sessionId) {
        console.log('📝 Ending session before closing HistoryService');
        this.historyManager.endSession(sessionId);
      }

      this.historyManager.close();
      this.historyManager = null;
    }

    this.currentProjectPath = null;
    console.log('✅ HistoryService closed');
  }

  /**
   * Check if history service is initialized
   */
  isInitialized(): boolean {
    return this.historyManager !== null;
  }

  /**
   * Get current project path
   */
  getCurrentProjectPath(): string | null {
    return this.currentProjectPath;
  }
}

export const historyService = new HistoryService();
