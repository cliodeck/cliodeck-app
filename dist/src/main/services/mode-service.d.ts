/**
 * Mode Service - Singleton wrapper for ModeManager
 *
 * Manages the active mode and integrates with the project lifecycle.
 * Follows the same pattern as history-service.ts.
 */
import { ModeManager } from '../../../backend/core/modes/ModeManager.js';
import type { ResolvedMode } from '../../../backend/types/mode.js';
declare class ModeService {
    private modeManager;
    private activeModeId;
    constructor();
    /**
     * Initialize with a project path (called when project loads)
     */
    init(projectPath: string): void;
    /**
     * Close and reset (called when project closes)
     */
    close(): void;
    /**
     * Get the currently active mode
     */
    getActiveMode(): Promise<ResolvedMode | undefined>;
    /**
     * Set the active mode by ID
     */
    setActiveMode(modeId: string): void;
    /**
     * Get the active mode ID
     */
    getActiveModeId(): string;
    /**
     * Get the underlying ModeManager for CRUD operations
     */
    getModeManager(): ModeManager;
}
export declare const modeService: ModeService;
export {};
