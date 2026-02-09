/**
 * Mode Type Definitions
 *
 * A Mode is a predefined profile that combines a system prompt,
 * generation parameters, RAG overrides, and model recommendations
 * into a coherent persona for specific research tasks.
 */
export {};
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
