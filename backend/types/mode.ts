/**
 * Mode Type Definitions
 *
 * A Mode is a predefined profile that combines a system prompt,
 * generation parameters, RAG overrides, and model recommendations
 * into a coherent persona for specific research tasks.
 */

// ============================================================================
// Base Types
// ============================================================================

export type ModeCategory =
  | 'general'
  | 'research'
  | 'writing'
  | 'review'
  | 'analysis'
  | 'methodology';

export type ModeSource = 'builtin' | 'global' | 'project';

/** Multilingual text (fr/en) */
export interface ModeLocalizedText {
  fr: string;
  en: string;
}

// ============================================================================
// Mode Components
// ============================================================================

/** LLM generation parameters applied when this mode is active */
export interface ModeGenerationParams {
  temperature: number;
  top_p: number;
  top_k: number;
  repeat_penalty: number;
}

/**
 * Posture d'un mode envers le manuscrit de l'utilisateur
 * (`docs/poids-du-manuscrit.md`, palier 2) :
 *  - `recall` (défaut) : le manuscrit entre avec sa bande de places et une
 *    consigne de rappel — dire ce que l'utilisateur a déjà écrit ;
 *  - `background` : une ou deux places au plus, présenté comme ce qu'il
 *    pense déjà et qu'il ne faut pas lui reformuler (brainstorming) ;
 *  - `off` : jamais interrogé (mode libre : sans prompt système, le texte de
 *    l'utilisateur n'aurait aucun cadre).
 * Une question de rappel explicite l'emporte sur la posture.
 */
export type ManuscriptStance = 'off' | 'background' | 'recall';

/**
 * RAG configuration overrides applied when this mode is active. Only defined
 * fields override the user's global RAG config.
 *
 * Retirés le 2026-10 parce que rien ne les lisait : `sourceType` (écriture
 * morte dans le renderer), `similarityThreshold`, `useGraphContext`,
 * `summaryGeneration`. Un fichier de mode qui les porte encore est accepté
 * et ignoré (`ModeManager` ne valide que la forme d'objet).
 */
export interface ModeRAGOverrides {
  topK?: number;
  numCtx?: number;
  enableContextCompression?: boolean;
  manuscript?: ManuscriptStance;
  /**
   * Posture envers les notes de lecture — l'autre corpus à la voix de
   * l'auteur. Absente, elle suit celle du manuscrit.
   */
  readingNotes?: ManuscriptStance;
}

/** Model recommendation (advisory, not enforced) */
export interface ModeModelRecommendation {
  /** Suggested Ollama model tags */
  suggestedModels: string[];
  /** Minimum context window in tokens */
  minContextWindow: number;
  /** Whether the embedded Qwen model is sufficient */
  embeddedCompatible: boolean;
  /** Warning shown when current model doesn't meet requirements */
  warningMessage?: ModeLocalizedText;
}

/** Mode identity and metadata */
export interface ModeMetadata {
  /** Unique slug identifier (e.g. 'literature-review') */
  id: string;
  /** Display name */
  name: ModeLocalizedText;
  /** Short description */
  description: ModeLocalizedText;
  /** Lucide icon name (e.g. 'BookOpen') */
  icon: string;
  /** Category for grouping in UI */
  category: ModeCategory;
  /** Semantic version */
  version: string;
  /** Author name or organization */
  author: string;
}

// ============================================================================
// Mode Definition
// ============================================================================

/** Complete mode definition */
export interface Mode {
  metadata: ModeMetadata;
  /** System prompt injected for this mode. Empty string = no system prompt (free mode). */
  systemPrompt: ModeLocalizedText;
  /** LLM generation parameters */
  generationParams: ModeGenerationParams;
  /** RAG config overrides (partial, undefined fields keep user's config) */
  ragOverrides: ModeRAGOverrides;
  /** Model recommendations (advisory) */
  modelRecommendation: ModeModelRecommendation;
}

/** Mode with runtime source information */
export interface ResolvedMode extends Mode {
  /** Where this mode was loaded from */
  source: ModeSource;
  /** File path for custom modes (global or project) */
  filePath?: string;
}

// ============================================================================
// File Format (import/export)
// ============================================================================

/** JSON file format for mode import/export and community sharing */
export interface ModeFileFormat {
  /** Optional JSON schema reference */
  $schema?: string;
  /** Format version */
  version: '1.0';
  /** The mode definition */
  mode: Mode;
}

// ============================================================================
// Future: Concurrent Execution (Phase 7 preparation)
// ============================================================================

// export interface ModeExecutionConfig {
//   /** Whether this mode can run in the background */
//   allowBackground: boolean;
//   /** Maximum concurrent instances of this mode */
//   maxConcurrent: number;
//   /** Priority relative to other background tasks (1-10, 10 = highest) */
//   priority: number;
// }
//
// export interface ModeSession {
//   id: string;
//   modeId: string;
//   status: 'active' | 'background' | 'paused' | 'completed';
//   startedAt: Date;
//   completedAt?: Date;
// }
