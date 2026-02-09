/**
 * Mode Service - Singleton wrapper for ModeManager
 *
 * Manages the active mode and integrates with the project lifecycle.
 * Follows the same pattern as history-service.ts.
 */
import { ModeManager } from '../../../backend/core/modes/ModeManager.js';
class ModeService {
    constructor() {
        this.activeModeId = 'default-assistant';
        this.modeManager = new ModeManager();
    }
    /**
     * Initialize with a project path (called when project loads)
     */
    init(projectPath) {
        this.modeManager.setProjectPath(projectPath);
        console.log('✅ Mode service initialized for project:', projectPath);
    }
    /**
     * Close and reset (called when project closes)
     */
    close() {
        this.modeManager.setProjectPath(null);
        this.activeModeId = 'default-assistant';
        console.log('🔒 Mode service closed');
    }
    /**
     * Get the currently active mode
     */
    async getActiveMode() {
        return this.modeManager.getMode(this.activeModeId);
    }
    /**
     * Set the active mode by ID
     */
    setActiveMode(modeId) {
        this.activeModeId = modeId;
    }
    /**
     * Get the active mode ID
     */
    getActiveModeId() {
        return this.activeModeId;
    }
    /**
     * Get the underlying ModeManager for CRUD operations
     */
    getModeManager() {
        return this.modeManager;
    }
}
export const modeService = new ModeService();
