import { HistoryManager, type ProposalEvent } from '../../../backend/core/history/HistoryManager.js';

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

    // Détaché avant d'être fermé, et ses erreurs gardées pour lui : un `close()` qui lève (la fin de
    // session sur la base précédente) rendait toute ouverture suivante impossible, et un échec de
    // `new HistoryManager` gardait l'instance fermée de A sous son chemin, que le retour sur A
    // prenait pour une base ouverte (S13-1-20). Rien n'est installé avant que B soit ouvert.
    const previous = this.historyManager;
    this.historyManager = null;
    this.currentProjectPath = null;
    if (previous) {
      console.log('📝 Closing previous HistoryManager');
      try {
        previous.close();
      } catch (error: unknown) {
        console.error('❌ Fermeture du journal de recherche précédent impossible :', error);
      }
    }

    // Create new history manager
    const manager = new HistoryManager(projectPath);
    this.historyManager = manager;
    this.currentProjectPath = projectPath;

    // Auto-start session with metadata
    const metadata = {
      platform: process.platform,
      nodeVersion: process.version,
      electronVersion: process.versions.electron,
      timestamp: new Date().toISOString(),
    };

    // Avant la nouvelle : les sessions qu'une sortie sans fermeture, un plantage ou un kill ont
    // laissées ouvertes se ferment à leur dernier événement. Une réparation qui échoue n'empêche
    // pas d'ouvrir le projet : elle se refera à la prochaine ouverture.
    try {
      manager.closeOrphanSessions();
    } catch (error: unknown) {
      console.error('❌ Sessions restées ouvertes non réparées :', error);
    }
    manager.startSession(metadata);
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
    // Détaché d'abord, comme dans `init` : une fin de session qui lève ne laisse pas au service une
    // base à moitié fermée.
    const manager = this.historyManager;
    this.historyManager = null;
    this.currentProjectPath = null;
    if (manager) {
      try {
        const sessionId = manager.getCurrentSessionId();
        if (sessionId) {
          console.log('📝 Ending session before closing HistoryService');
          manager.endSession(sessionId);
        }
      } finally {
        manager.close();
      }
    }

    console.log('✅ HistoryService closed');
  }

  /**
   * Journal de recherche — adjudication d'une proposition IA (plan CM6,
   * Phase 4), contenus complets. Rattachée à la session active ; no-op si
   * aucun projet n'est ouvert (retourne '').
   */
  logProposalAdjudication(
    event: Omit<ProposalEvent, 'id' | 'sessionId'>
  ): string {
    if (!this.historyManager) return '';
    return this.historyManager.logProposalAdjudication(event);
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
