/**
 * Journal d'usage IA — types partagés (couche factuelle + décisionnelle).
 *
 * Instrument réflexif, PAS de la télémétrie. Voir
 * `docs/INSTRUCTIONS_journal-usage-ia.md` et `docs/journal-usage-ia-reperage.md`.
 * Strictement séparé du *journal de recherche* existant (`history_*` dans
 * `brain.db`, qui journalise les prompts) : ici, ni prompt ni contenu — seulement
 * volumes, contexte applicatif et annotations décisionnelles.
 */

/**
 * Mode applicatif au moment de l'appel. `explore|brainstorm|write|export` viennent
 * de la navigation 4-modes du renderer (`workspaceModeStore`) ; `recipe|mcp|cli` sont
 * des contextes d'exécution posés côté backend. `unknown` = mode non renseigné.
 * NB : l'instruction dit `analyze`, l'app dit `explore` — même chose.
 */
export type UsageMode =
  | 'brainstorm'
  | 'write'
  | 'explore'
  | 'export'
  | 'recipe'
  | 'mcp'
  | 'cli'
  | 'unknown';

/** Corpus concerné par une indexation en masse (agrégée en `embedding_batch`). */
export type BatchCorpus = 'pdf' | 'obsidian' | 'tropy';

export type InferenceKind =
  | 'completion'
  | 'embedding'
  | 'embedding_batch'
  | 'mcp_session';

export type InferenceStatus = 'ok' | 'error';

export type Verdict = 'worth_it' | 'not_worth_it' | 'unsure' | 'pending';

/**
 * Événement de la couche factuelle, tel que persisté dans `inference_events`.
 * `sessionId` et `workspace` sont résolus par le service au moment de l'écriture.
 */
export interface InferenceEvent {
  id: string;
  sessionId: string;
  /** ISO 8601, horodatage de début. */
  at: string;
  durationMs: number;
  kind: InferenceKind;
  provider: string;
  model: string;
  isLocal: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** true si les tokens sont estimés (chars/4) faute d'usage renvoyé par l'API. */
  tokensEstimated: boolean;
  /** Nombre de chunks agrégés — présent pour `embedding_batch`. */
  chunkCount?: number;
  mode: UsageMode;
  workspace: string;
  corpus?: string;
  recipeId?: string;
  status: InferenceStatus;
  /** Pointeur libre (p.ex. plage de lignes dans `mcp-access.jsonl`). */
  ref?: string;
}

/**
 * Entrée produite par le hook providers (couche factuelle). Le service enrichit
 * ensuite avec `sessionId`, `workspace`, `mode` (contexte ambiant) avant écriture.
 */
export interface RecordInferenceInput {
  kind: InferenceKind;
  provider: string;
  model: string;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  tokensEstimated: boolean;
  chunkCount?: number;
  status: InferenceStatus;
  ref?: string;
  /** Overrides de contexte (sinon lus dans l'AsyncLocalStorage / le miroir de mode). */
  mode?: UsageMode;
  workspaceRoot?: string;
  corpus?: string;
  recipeId?: string;
  /**
   * Localité résolue par le décorateur (qui connaît le baseUrl : un
   * openai-compatible sur localhost est local). Sinon, heuristique du sink.
   */
  isLocal?: boolean;
}

/** Décision d'usage (couche décisionnelle), table `usage_decisions`. */
export interface UsageDecision {
  id: string;
  /** ISO date (jour) de la décision. */
  date: string;
  workspace: string;
  task: string;
  alternative: string;
  justification: string;
  verdict: Verdict;
  verdictNote?: string;
}

/** Rattachement manuel session ↔ décision, table `session_decision`. */
export interface SessionDecisionLink {
  sessionId: string;
  decisionId: string;
}
