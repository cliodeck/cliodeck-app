/**
 * Built-in Modes for ClioDeck
 *
 * 7 predefined modes optimized for academic research workflows in
 * humanities and social sciences, particularly history.
 */
import type { Mode } from '../../types/mode.js';
export declare const BUILTIN_MODES: Mode[];
/**
 * Get a built-in mode by its ID
 */
export declare function getBuiltinMode(id: string): Mode | undefined;
/**
 * Get all built-in mode IDs
 */
export declare function getBuiltinModeIds(): string[];
