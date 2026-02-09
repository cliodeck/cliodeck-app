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

import { readFile, writeFile, readdir, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import type { Mode, ResolvedMode, ModeFileFormat, ModeSource } from '../../types/mode.js';
import { BUILTIN_MODES } from './built-in-modes.js';

export class ModeManager {
  private projectPath: string | null;

  constructor(projectPath?: string) {
    this.projectPath = projectPath || null;
  }

  // =========================================================================
  // Directory paths
  // =========================================================================

  private getGlobalModesDir(): string {
    return path.join(os.homedir(), '.config', 'cliodeck', 'modes');
  }

  private getProjectModesDir(): string | null {
    if (!this.projectPath) return null;
    return path.join(this.projectPath, 'cliodeck-data', 'modes');
  }

  // =========================================================================
  // Read operations
  // =========================================================================

  /**
   * Get all available modes, merged from all sources.
   * Priority: project > global > builtin
   */
  async getAllModes(): Promise<ResolvedMode[]> {
    const modesMap = new Map<string, ResolvedMode>();

    // 1. Built-in modes (lowest priority)
    for (const mode of BUILTIN_MODES) {
      modesMap.set(mode.metadata.id, {
        ...mode,
        source: 'builtin' as ModeSource,
      });
    }

    // 2. Global modes (override built-in)
    const globalDir = this.getGlobalModesDir();
    const globalModes = await this.loadModesFromDirectory(globalDir, 'global');
    for (const mode of globalModes) {
      modesMap.set(mode.metadata.id, mode);
    }

    // 3. Project modes (highest priority)
    const projectDir = this.getProjectModesDir();
    if (projectDir) {
      const projectModes = await this.loadModesFromDirectory(projectDir, 'project');
      for (const mode of projectModes) {
        modesMap.set(mode.metadata.id, mode);
      }
    }

    return Array.from(modesMap.values());
  }

  /**
   * Get a single mode by ID
   */
  async getMode(modeId: string): Promise<ResolvedMode | undefined> {
    const allModes = await this.getAllModes();
    return allModes.find((m) => m.metadata.id === modeId);
  }

  // =========================================================================
  // Write operations
  // =========================================================================

  /**
   * Save a custom mode to global or project directory
   * @returns The file path where the mode was saved
   */
  async saveMode(mode: Mode, target: 'global' | 'project'): Promise<string> {
    const dir = target === 'global' ? this.getGlobalModesDir() : this.getProjectModesDir();

    if (!dir) {
      throw new Error('No project loaded — cannot save to project modes directory');
    }

    // Ensure directory exists
    await mkdir(dir, { recursive: true });

    const filePath = path.join(dir, `${mode.metadata.id}.json`);
    const fileContent: ModeFileFormat = {
      version: '1.0',
      mode,
    };

    await writeFile(filePath, JSON.stringify(fileContent, null, 2), 'utf-8');
    console.log(`✅ Mode saved: ${filePath}`);
    return filePath;
  }

  /**
   * Delete a custom mode
   */
  async deleteMode(modeId: string, source: 'global' | 'project'): Promise<void> {
    const dir = source === 'global' ? this.getGlobalModesDir() : this.getProjectModesDir();

    if (!dir) {
      throw new Error('No project loaded — cannot delete from project modes directory');
    }

    const filePath = path.join(dir, `${modeId}.json`);

    if (!existsSync(filePath)) {
      throw new Error(`Mode file not found: ${filePath}`);
    }

    await unlink(filePath);
    console.log(`🗑️ Mode deleted: ${filePath}`);
  }

  /**
   * Import a mode from an external JSON file
   * @returns The imported mode with source info
   */
  async importMode(filePath: string, target: 'global' | 'project'): Promise<ResolvedMode> {
    const content = await readFile(filePath, 'utf-8');
    const validation = ModeManager.validateModeFile(content);

    if (!validation.valid) {
      throw new Error(`Invalid mode file: ${validation.errors.join(', ')}`);
    }

    const parsed: ModeFileFormat = JSON.parse(content);
    const savedPath = await this.saveMode(parsed.mode, target);

    return {
      ...parsed.mode,
      source: target,
      filePath: savedPath,
    };
  }

  /**
   * Export a mode to a JSON file
   */
  async exportMode(modeId: string, outputPath: string): Promise<void> {
    const mode = await this.getMode(modeId);
    if (!mode) {
      throw new Error(`Mode not found: ${modeId}`);
    }

    // Strip runtime fields for export
    const { source: _source, filePath: _filePath, ...modeData } = mode;
    const fileContent: ModeFileFormat = {
      version: '1.0',
      mode: modeData,
    };

    await writeFile(outputPath, JSON.stringify(fileContent, null, 2), 'utf-8');
    console.log(`📦 Mode exported: ${outputPath}`);
  }

  // =========================================================================
  // Validation
  // =========================================================================

  /**
   * Validate a mode JSON file content
   */
  static validateModeFile(content: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { valid: false, errors: ['Invalid JSON'] };
    }

    if (!parsed.version) {
      errors.push('Missing "version" field');
    } else if (parsed.version !== '1.0') {
      errors.push(`Unsupported version: ${parsed.version}`);
    }

    if (!parsed.mode) {
      errors.push('Missing "mode" field');
      return { valid: false, errors };
    }

    const mode = parsed.mode;

    // Validate metadata
    if (!mode.metadata) {
      errors.push('Missing "metadata"');
    } else {
      if (!mode.metadata.id || typeof mode.metadata.id !== 'string') {
        errors.push('metadata.id must be a non-empty string');
      } else if (!/^[a-z0-9-]+$/.test(mode.metadata.id)) {
        errors.push('metadata.id must contain only lowercase letters, numbers, and hyphens');
      }
      if (!mode.metadata.name?.fr || !mode.metadata.name?.en) {
        errors.push('metadata.name must have fr and en fields');
      }
      if (!mode.metadata.icon) {
        errors.push('metadata.icon is required');
      }
      if (!mode.metadata.category) {
        errors.push('metadata.category is required');
      }
      if (!mode.metadata.version) {
        errors.push('metadata.version is required');
      }
      if (!mode.metadata.author) {
        errors.push('metadata.author is required');
      }
    }

    // Validate systemPrompt
    if (!mode.systemPrompt || (typeof mode.systemPrompt.fr !== 'string' || typeof mode.systemPrompt.en !== 'string')) {
      errors.push('systemPrompt must have fr and en string fields');
    }

    // Validate generationParams
    if (!mode.generationParams) {
      errors.push('Missing "generationParams"');
    } else {
      const gp = mode.generationParams;
      if (typeof gp.temperature !== 'number' || gp.temperature < 0 || gp.temperature > 2) {
        errors.push('generationParams.temperature must be 0-2');
      }
      if (typeof gp.top_p !== 'number' || gp.top_p < 0 || gp.top_p > 1) {
        errors.push('generationParams.top_p must be 0-1');
      }
      if (typeof gp.top_k !== 'number' || gp.top_k < 1 || gp.top_k > 100) {
        errors.push('generationParams.top_k must be 1-100');
      }
      if (typeof gp.repeat_penalty !== 'number' || gp.repeat_penalty < 0 || gp.repeat_penalty > 2) {
        errors.push('generationParams.repeat_penalty must be 0-2');
      }
    }

    // ragOverrides and modelRecommendation are optional, just check types if present
    if (mode.ragOverrides && typeof mode.ragOverrides !== 'object') {
      errors.push('ragOverrides must be an object');
    }

    return { valid: errors.length === 0, errors };
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  setProjectPath(projectPath: string | null): void {
    this.projectPath = projectPath;
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Load custom modes from a directory
   */
  private async loadModesFromDirectory(
    dirPath: string,
    source: 'global' | 'project',
  ): Promise<ResolvedMode[]> {
    if (!existsSync(dirPath)) {
      return [];
    }

    const modes: ResolvedMode[] = [];

    try {
      const files = await readdir(dirPath);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));

      for (const file of jsonFiles) {
        const filePath = path.join(dirPath, file);
        try {
          const content = await readFile(filePath, 'utf-8');
          const validation = ModeManager.validateModeFile(content);

          if (!validation.valid) {
            console.warn(`⚠️ Skipping invalid mode file ${filePath}: ${validation.errors.join(', ')}`);
            continue;
          }

          const parsed: ModeFileFormat = JSON.parse(content);
          modes.push({
            ...parsed.mode,
            source,
            filePath,
          });
        } catch (err) {
          console.warn(`⚠️ Failed to load mode file ${filePath}:`, err);
        }
      }
    } catch (err) {
      console.warn(`⚠️ Failed to read modes directory ${dirPath}:`, err);
    }

    return modes;
  }
}
