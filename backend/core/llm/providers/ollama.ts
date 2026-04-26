/**
 * Ollama provider (fusion step 1.2).
 *
 * Thin LLMProvider/EmbeddingProvider implementation over the Ollama HTTP API.
 * As of fusion step 1.2g this is the only Ollama integration in the
 * codebase — the legacy `OllamaClient` (RAG-coupled, tangled with
 * `SearchResult` types) was removed once all consumers had been
 * migrated to the typed registry.
 */

import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  CompleteOptions,
  EmbeddingProvider,
  LLMProvider,
  ProviderCapabilities,
  ProviderStatus,
} from './base.js';

export interface OllamaProviderConfig {
  baseUrl?: string;
  model: string;
}

export interface OllamaEmbeddingProviderConfig {
  baseUrl?: string;
  model: string;
  /** Declared vector dimension; used before any live call. Verified on first embed. */
  dimension: number;
}

const DEFAULT_BASE = 'http://127.0.0.1:11434';

/**
 * Models known to emit valid `tool_calls` JSON consistently when served by
 * Ollama. Conservative by design — see `docs/research-ollama-tools-1.8.md`
 * for the source-cited rationale per family. The Llama 3.x and 4.x families
 * are intentionally absent: both generations exhibit the failure mode the
 * original `capabilities.tools = false` comment described (looping malformed
 * `tool_calls`, raw JSON in the `content` field instead of structured calls).
 *
 * Each entry is anchored with `^` so a substring like `qwen` doesn't match
 * `qwen2.5:0.5b`, and uses `\b` to allow further suffixes such as
 * quantization variants (`qwen3:8b-q4_K_M`) without permitting a different
 * size to slip through (`qwen3:80b` doesn't match `qwen3:8b\b`).
 */
const OLLAMA_TOOL_CAPABLE_PATTERNS: readonly RegExp[] = [
  /^ministral-3:8b\b/,
  /^ministral-3:14b\b/,
  /^qwen3:8b\b/,
  /^qwen3:14b\b/,
  /^qwen3:32b\b/,
  /^mistral-nemo(:|$)/,
];

/**
 * True iff `modelName` matches the tool-use whitelist. Exported so the
 * registry, the renderer's model-picker, and tests can all reason about
 * the same source of truth.
 */
export function isOllamaToolCapableModel(modelName: string | undefined): boolean {
  if (!modelName) return false;
  return OLLAMA_TOOL_CAPABLE_PATTERNS.some((p) => p.test(modelName));
}

function now(): string {
  return new Date().toISOString();
}

async function fetchJson<T>(
  url: string,
  body: unknown,
  signal?: AbortSignal
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';
  readonly name = 'Ollama';
  // `tools` is per-model: most Ollama-served Llama variants either loop on
  // malformed `tool_calls` or return an empty stream. Only models in
  // `OLLAMA_TOOL_CAPABLE_PATTERNS` (qwen3, ministral-3, mistral-nemo) emit
  // valid `tool_calls` JSON consistently. The getter reads `this.model` so
  // a Provider configured with `qwen3:8b` advertises `tools: true` while the
  // same class instantiated with `llama3.2` advertises `tools: false`.
  get capabilities(): ProviderCapabilities {
    return {
      chat: true,
      streaming: true,
      tools: isOllamaToolCapableModel(this.model),
      embeddings: false,
    };
  }

  private status: ProviderStatus = { state: 'unconfigured' };
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(cfg: OllamaProviderConfig) {
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.model = cfg.model;
    this.status = { state: 'handshaking' };
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  async healthCheck(): Promise<ProviderStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { models?: Array<{ name: string }> };
      const names = (body.models ?? []).map((m) => m.name);
      const hasModel = names.some(
        (n) => n === this.model || n.startsWith(`${this.model}:`)
      );
      if (!hasModel) {
        this.status = {
          state: 'degraded',
          lastError: {
            code: 'ollama_model_missing',
            message: `Model "${this.model}" not pulled. Run: ollama pull ${this.model}`,
            at: now(),
          },
        };
        return this.status;
      }
      this.status = { state: 'ready', lastReadyAt: now() };
    } catch (e) {
      this.status = {
        state: 'failed',
        lastError: {
          code: 'ollama_unreachable',
          message: e instanceof Error ? e.message : String(e),
          at: now(),
        },
      };
    }
    return this.status;
  }

  async *chat(
    messages: ChatMessage[],
    opts: ChatOptions = {}
  ): AsyncIterable<ChatChunk> {
    const model = opts.model ?? this.model;
    const body = {
      model,
      messages: messages.map((m) => {
        const base: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        if (m.role === 'assistant' && m.toolCalls?.length) {
          // Ollama requires `arguments` as an object, not a JSON string.
          base.content = m.content ?? '';
          base.tool_calls = m.toolCalls.map((tc) => {
            let parsed: unknown = {};
            try {
              parsed = tc.arguments ? JSON.parse(tc.arguments) : {};
            } catch {
              parsed = {};
            }
            return { function: { name: tc.name, arguments: parsed } };
          });
        }
        return base;
      }),
      stream: true,
      options: {
        temperature: opts.temperature,
        top_p: opts.topP,
        top_k: opts.topK,
        num_predict: opts.maxTokens,
        stop: opts.stop,
      },
      ...(opts.tools
        ? {
            tools: opts.tools.map((t) => ({
              type: 'function',
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            })),
          }
        : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (e) {
      this.status = {
        state: 'failed',
        lastError: {
          code: 'ollama_request_failed',
          message: e instanceof Error ? e.message : String(e),
          at: now(),
        },
      };
      yield { delta: '', done: true, finishReason: 'error' };
      return;
    }

    if (!res.ok || !res.body) {
      yield { delta: '', done: true, finishReason: 'error' };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let toolCallCounter = 0;
    let sawToolCall = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line) as {
              message?: {
                content?: string;
                tool_calls?: Array<{
                  function?: {
                    name?: string;
                    arguments?: Record<string, unknown> | string;
                  };
                }>;
              };
              done?: boolean;
              done_reason?: string;
              prompt_eval_count?: number;
              eval_count?: number;
            };
            const delta = obj.message?.content ?? '';
            const tcs = obj.message?.tool_calls;
            if (tcs?.length) {
              for (const tc of tcs) {
                if (!tc.function?.name) continue;
                sawToolCall = true;
                const rawArgs = tc.function.arguments;
                const argsJson =
                  typeof rawArgs === 'string'
                    ? rawArgs
                    : JSON.stringify(rawArgs ?? {});
                yield {
                  delta: '',
                  toolCall: {
                    id: `ollama-tc-${++toolCallCounter}`,
                    name: tc.function.name,
                    arguments: argsJson,
                  },
                };
              }
            }
            if (obj.done) {
              const finishReason: ChatChunk['finishReason'] = sawToolCall
                ? 'tool_call'
                : obj.done_reason === 'length'
                  ? 'length'
                  : 'stop';
              yield {
                delta,
                done: true,
                finishReason,
                usage: {
                  promptTokens: obj.prompt_eval_count,
                  completionTokens: obj.eval_count,
                  totalTokens:
                    (obj.prompt_eval_count ?? 0) + (obj.eval_count ?? 0),
                },
              };
            } else if (delta) {
              yield { delta };
            }
          } catch {
            // skip malformed line
          }
        }
      }
    } catch (e) {
      const cancelled = opts.signal?.aborted;
      yield {
        delta: '',
        done: true,
        finishReason: cancelled ? 'cancelled' : 'error',
      };
      if (!cancelled) {
        this.status = {
          state: 'degraded',
          lastError: {
            code: 'ollama_stream_failed',
            message: e instanceof Error ? e.message : String(e),
            at: now(),
          },
        };
      }
    }
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    let out = '';
    for await (const chunk of this.chat(
      [{ role: 'user', content: prompt }],
      opts
    )) {
      out += chunk.delta;
    }
    return out;
  }

  async dispose(): Promise<void> {
    this.status = { state: 'stopped' };
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'ollama-embedding';
  readonly name = 'Ollama Embeddings';
  readonly dimension: number;
  readonly model: string;

  private status: ProviderStatus = { state: 'unconfigured' };
  private readonly baseUrl: string;

  constructor(cfg: OllamaEmbeddingProviderConfig) {
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.model = cfg.model;
    this.dimension = cfg.dimension;
    this.status = { state: 'handshaking' };
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  async healthCheck(): Promise<ProviderStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { models?: Array<{ name: string }> };
      const names = (body.models ?? []).map((m) => m.name);
      const hasModel = names.some(
        (n) => n === this.model || n.startsWith(`${this.model}:`)
      );
      if (!hasModel) {
        this.status = {
          state: 'degraded',
          lastError: {
            code: 'ollama_model_missing',
            message: `Model "${this.model}" not pulled. Run: ollama pull ${this.model}`,
            at: now(),
          },
        };
        return this.status;
      }
      this.status = { state: 'ready', lastReadyAt: now() };
    } catch (e) {
      this.status = {
        state: 'failed',
        lastError: {
          code: 'ollama_unreachable',
          message: e instanceof Error ? e.message : String(e),
          at: now(),
        },
      };
    }
    return this.status;
  }

  async embed(
    texts: string[],
    opts: { signal?: AbortSignal } = {}
  ): Promise<number[][]> {
    const out: number[][] = [];
    for (const t of texts) {
      const res = await fetchJson<{ embedding: number[] }>(
        `${this.baseUrl}/api/embeddings`,
        { model: this.model, prompt: t },
        opts.signal
      );
      if (res.embedding.length !== this.dimension) {
        throw new Error(
          `Embedding dimension mismatch: got ${res.embedding.length}, declared ${this.dimension}`
        );
      }
      out.push(res.embedding);
    }
    return out;
  }

  async dispose(): Promise<void> {
    this.status = { state: 'stopped' };
  }
}
