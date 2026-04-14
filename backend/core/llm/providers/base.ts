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
  maxTokens?: number;
  stop?: string[];
  /** Tool-calling, when `capabilities.tools` is true. */
  tools?: ToolDescriptor[];
  /** Abort cooperatively. */
  signal?: AbortSignal;
}

export interface CompleteOptions extends ChatOptions {}

export interface ChatChunk {
  /** Incremental delta of assistant text. Empty when only metadata is emitted. */
  delta: string;
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
