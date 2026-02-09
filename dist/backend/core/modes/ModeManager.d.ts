/**
 * ModeManager - Loads, saves, and manages modes from all sources
 *
 * Sources (in priority order):
 * 1. Project modes: <project>/cliodeck-data/modes/
 * 2. Global modes: ~/.config/cliodeck/modes/
 * 3. Built-in modes: hardcoded in built-in-modes.ts
 *
 * A project mode with the same ID as a global or built-in mode overrides it.
 */
import type { Mode, ResolvedMode } from '../../types/mode.js';
export declare class ModeManager {
    private projectPath;
    constructor(projectPath?: string);
    private getGlobalModesDir;
    private getProjectModesDir;
    /**
     * Get all available modes, merged from all sources.
     * Priority: project > global > builtin
     */
    getAllModes(): Promise<ResolvedMode[]>;
    /**
     * Get a single mode by ID
     */
    getMode(modeId: string): Promise<ResolvedMode | undefined>;
    /**
     * Save a custom mode to global or project directory
     * @returns The file path where the mode was saved
     */
    saveMode(mode: Mode, target: 'global' | 'project'): Promise<string>;
    /**
     * Delete a custom mode
     */
    deleteMode(modeId: string, source: 'global' | 'project'): Promise<void>;
    /**
     * Import a mode from an external JSON file
     * @returns The imported mode with source info
     */
    importMode(filePath: string, target: 'global' | 'project'): Promise<ResolvedMode>;
    /**
     * Export a mode to a JSON file
     */
    exportMode(modeId: string, outputPath: string): Promise<void>;
    /**
     * Validate a mode JSON file content
     */
    static validateModeFile(content: string): {
        valid: boolean;
        errors: string[];
    };
    setProjectPath(projectPath: string | null): void;
    /**
     * Load custom modes from a directory
     */
    private loadModesFromDirectory;
}
