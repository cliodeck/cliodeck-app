/**
 * Provider abstraction (fusion step 1.1, goose lesson #1).
 *
 * Every LLM backend (Ollama, OpenAI-compatible, Anthropic, Mistral…) implements
 * `LLMProvider`. Adding a model = adding a file under `providers/`, not touching
 * the core. Embeddings have a symmetric `EmbeddingProvider` since the producing
 * service may differ from the chat one (e.g. Ollama chat + OpenAI embeddings).
 *
 * State machine (claw-code lesson 6.1): every long-lived provider instance
 * exposes a typed `ProviderState`, not a boolean `connected`.
 */

export type ProviderState =
  | 'unconfigured'
  | 'spawning'
  | 'handshaking'
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'stopped';

export interface ProviderError {
  code: string;
  message: string;
  at: string;
}

export interface ProviderStatus {
  state: ProviderState;
  lastError?: ProviderError;
  lastReadyAt?: string;
}

/**
 * Optional per-message metadata. Kept narrow on purpose — every field must have
 * a clear cross-provider meaning. Providers MUST ignore unknown fields.
 */
export interface ChatMessageMeta {
  /**
   * Marks a message as carrying a RAG citation payload (retrieved chunk,
   * bibliographic snippet, quoted source). Consumers such as the context
   * compactor use this to preserve the message verbatim rather than
   * summarizing it. See fusion step 4.2.
   */
  ragCitation?: boolean;
  /** Optional identifier of the underlying source (for UI / traceability). */
  sourceId?: string;
  /** Optional chunk identifier inside the source. */
  chunkId?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Optional name for tool messages. */
  name?: string;
  /** Tool call id for tool-role messages. */
  toolCallId?: string;
  /**
   * For assistant messages that triggered tool calls. Providers map this
   * to their own structured representation (OpenAI's tool_calls array,
   * Anthropic's tool_use content blocks, Gemini's functionCall parts).
   * `arguments` is the JSON-stringified argument object.
   */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  /** Optional cross-provider metadata; providers MUST ignore unknown fields. */
  meta?: ChatMessageMeta;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON-schema of the tool parameters. */
  parameters: Record<string, unknown>;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  /**
   * Pénalité de répétition (`repeat_penalty` d'Ollama / llama.cpp, 1.0 =
   * aucune). Seuls les backends locaux l'exposent ; les fournisseurs cloud
   * l'ignorent — leurs `frequency_penalty` / `presence_penalty` n'ont pas la
   * même sémantique et ne doivent pas être dérivés de cette valeur.
   */
  repeatPenalty?: number;
  /**
   * Modèles « pensants » (Qwen 3.x, DeepSeek-R1…) : `false` demande au
   * backend de répondre sans phase de raisonnement. Ollama seulement
   * (`think` de `/api/chat`) ; les fournisseurs cloud ont leurs propres
   * réglages de raisonnement et ignorent ce champ. Absent = défaut du backend.
   */
  think?: boolean;
  maxTokens?: number;
  stop?: string[];
  /**
   * Override the context window the backend uses for this call.
   * Only meaningful for backends that let the caller resize the prompt
   * window per request (Ollama's `options.num_ctx`); cloud providers
   * with a fixed model-level window MUST ignore this field. When
   * omitted, the backend keeps its own default — usually too small for
   * long brainstorm sessions on local models (Ollama defaults to 2048).
   */
  numCtx?: number;
  /** Tool-calling, when `capabilities.tools` is true. */
  tools?: ToolDescriptor[];
  /** Abort cooperatively. */
  signal?: AbortSignal;
}

export interface CompleteOptions extends ChatOptions {}

export interface ChatChunk {
  /** Incremental delta of assistant text. Empty when only metadata is emitted. */
  delta: string;
  /**
   * Fragment de raisonnement d'un modèle « pensant », distinct de la
   * réponse. Ollama les envoie avant tout `delta` de contenu ; un
   * consommateur qui les ignore voit un modèle muet pendant des minutes —
   * c'est ce qui a fait tomber le délai d'inactivité le 2026-09-08.
   */
  thinking?: string;
  /** Tool call emitted by the model, if any. */
  toolCall?: {
    id: string;
    name: string;
    arguments: string;
  };
  /** Present on the terminal chunk. */
  done?: boolean;
  /** Present on terminal chunk when reported by the backend. */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  finishReason?: 'stop' | 'length' | 'tool_call' | 'error' | 'cancelled';
}

export interface ProviderCapabilities {
  chat: boolean;
  streaming: boolean;
  tools: boolean;
  /** Some providers expose only embeddings or only chat. */
  embeddings: boolean;
}

export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  /** Resolved model identifier (e.g. `qwen3:8b`, `claude-sonnet-4-5`). */
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  /** Current state; cheap getter backed by internal state machine. */
  getStatus(): ProviderStatus;

  /** One-shot health check; updates internal state. */
  healthCheck(): Promise<ProviderStatus>;

  /**
   * Streamed chat. Implementations MUST yield at least one chunk with `done:true`,
   * even on error (with `finishReason:'error'`); never throw once streaming has begun.
   */
  chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<ChatChunk>;

  /** Non-streamed completion; convenience over `chat`. */
  complete(prompt: string, opts?: CompleteOptions): Promise<string>;

  /** Release resources (stop subprocess, close sockets). Idempotent. */
  dispose(): Promise<void>;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly name: string;
  readonly dimension: number;
  readonly model: string;

  getStatus(): ProviderStatus;
  healthCheck(): Promise<ProviderStatus>;

  /** Embed a batch of texts; returns vectors of length `dimension`. */
  embed(texts: string[], opts?: { signal?: AbortSignal }): Promise<number[][]>;

  dispose(): Promise<void>;
}
