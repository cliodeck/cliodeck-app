/**
 * Mode Service - Singleton wrapper for ModeManager
 *
 * Manages the active mode and integrates with the project lifecycle.
 * Follows the same pattern as history-service.ts.
 */

import { ModeManager } from '../../../backend/core/modes/ModeManager.js';
import type { ResolvedMode } from '../../../backend/types/mode.js';

class ModeService {
  private modeManager: ModeManager;
  private activeModeId: string = 'default-assistant';

  constructor() {
    this.modeManager = new ModeManager();
  }

  /**
   * Initialize with a project path (called when project loads)
   */
  init(projectPath: string): void {
    this.modeManager.setProjectPath(projectPath);
    console.log('✅ Mode service initialized for project:', projectPath);
  }

  /**
   * Close and reset (called when project closes)
   */
  close(): void {
    this.modeManager.setProjectPath(null);
    this.activeModeId = 'default-assistant';
    console.log('🔒 Mode service closed');
  }

  /**
   * Get the currently active mode
   */
  async getActiveMode(): Promise<ResolvedMode | undefined> {
    return this.modeManager.getMode(this.activeModeId);
  }

  /**
   * Set the active mode by ID
   */
  setActiveMode(modeId: string): void {
    this.activeModeId = modeId;
  }

  /**
   * Get the active mode ID
   */
  getActiveModeId(): string {
    return this.activeModeId;
  }

  /**
   * Get the underlying ModeManager for CRUD operations
   */
  getModeManager(): ModeManager {
    return this.modeManager;
  }

  // Future: concurrent mode execution
  // private executionSlots: Map<string, ModeSession> = new Map();
  // async launchBackground(modeId: string, query: string): Promise<string> { ... }
  // async getBackgroundResults(slotId: string): Promise<...> { ... }
}

export const modeService = new ModeService();
