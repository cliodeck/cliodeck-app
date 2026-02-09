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

/** RAG configuration overrides applied when this mode is active.
 *  Only defined fields override the user's global RAG config. */
export interface ModeRAGOverrides {
  topK?: number;
  sourceType?: 'secondary' | 'primary' | 'both';
  numCtx?: number;
  useGraphContext?: boolean;
  enableContextCompression?: boolean;
  similarityThreshold?: number;
  summaryGeneration?: 'extractive' | 'abstractive' | 'disabled';
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
