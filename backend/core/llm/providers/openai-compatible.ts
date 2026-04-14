/**
 * OpenAI-compatible provider (fusion step 1.2).
 *
 * Covers any backend speaking the OpenAI Chat Completions + Embeddings API:
 * OpenAI proper, llama.cpp server, LM Studio, vLLM, Together, Groq, etc.
 * Distinguished from `OllamaProvider` — Ollama has its own /api/chat schema.
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

export interface OpenAICompatProviderConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface OpenAICompatEmbeddingConfig {
  baseUrl: string;
  model: string;
  dimension: number;
  apiKey?: string;
}

function now(): string {
  return new Date().toISOString();
}

function authHeaders(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string = 'openai-compatible';
  readonly name: string = 'OpenAI-compatible';
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    tools: true,
    embeddings: false,
  };

  private status: ProviderStatus = { state: 'handshaking' };
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;

  constructor(cfg: OpenAICompatProviderConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
    this.model = cfg.model;
    this.apiKey = cfg.apiKey;
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  async healthCheck(): Promise<ProviderStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: authHeaders(this.apiKey),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.status = { state: 'ready', lastReadyAt: now() };
    } catch (e) {
      this.status = {
        state: 'failed',
        lastError: {
          code: 'openai_compat_unreachable',
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
    const body = {
      model: opts.model ?? this.model,
      messages: messages.map((m) => {
        const base: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        if (m.name) base.name = m.name;
        if (m.toolCallId) base.tool_call_id = m.toolCallId;
        if (m.role === 'assistant' && m.toolCalls?.length) {
          base.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments || '{}' },
          }));
          // OpenAI requires content to be string|null when tool_calls present.
          if (!m.content) base.content = null;
        }
        return base;
      }),
      temperature: opts.temperature,
      top_p: opts.topP,
      max_tokens: opts.maxTokens,
      stop: opts.stop,
      stream: true,
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
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: authHeaders(this.apiKey),
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (e) {
      this.status = {
        state: 'failed',
        lastError: {
          code: 'openai_compat_request_failed',
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

    // OpenAI streams tool_calls in fragments: the first delta carries the
    // function name + id, subsequent deltas append to `arguments`. Multiple
    // parallel calls are indexed by `index`. Accumulate here and emit one
    // toolCall ChatChunk per call when finish_reason='tool_calls' arrives.
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; argsJson: string }
    >();
    let finalUsage: ChatChunk['usage'] | undefined;

    const flushToolCalls = function* (): Generator<ChatChunk> {
      for (const [, p] of pendingToolCalls) {
        if (!p.name) continue;
        yield {
          delta: '',
          toolCall: { id: p.id, name: p.name, arguments: p.argsJson || '{}' },
        };
      }
      pendingToolCalls.clear();
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            if (payload === '[DONE]') {
              yield* flushToolCalls();
              yield {
                delta: '',
                done: true,
                finishReason: 'stop',
                usage: finalUsage,
              };
              return;
            }
            try {
              const obj = JSON.parse(payload) as {
                choices?: Array<{
                  delta?: {
                    content?: string;
                    tool_calls?: Array<{
                      index?: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                  finish_reason?: string | null;
                }>;
                usage?: {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                  total_tokens?: number;
                };
              };
              const choice = obj.choices?.[0];
              const delta = choice?.delta?.content ?? '';
              const tcs = choice?.delta?.tool_calls;
              const finishReason = choice?.finish_reason;
              if (obj.usage) {
                finalUsage = {
                  promptTokens: obj.usage.prompt_tokens,
                  completionTokens: obj.usage.completion_tokens,
                  totalTokens: obj.usage.total_tokens,
                };
              }
              if (tcs?.length) {
                for (const tc of tcs) {
                  const idx = tc.index ?? 0;
                  const slot = pendingToolCalls.get(idx) ?? {
                    id: '',
                    name: '',
                    argsJson: '',
                  };
                  if (tc.id) slot.id = tc.id;
                  if (tc.function?.name) slot.name = tc.function.name;
                  if (tc.function?.arguments) {
                    slot.argsJson += tc.function.arguments;
                  }
                  pendingToolCalls.set(idx, slot);
                }
              }
              if (delta) yield { delta };
              if (finishReason) {
                yield* flushToolCalls();
                yield {
                  delta: '',
                  done: true,
                  finishReason:
                    finishReason === 'length'
                      ? 'length'
                      : finishReason === 'tool_calls'
                        ? 'tool_call'
                        : 'stop',
                  usage: finalUsage,
                };
                return;
              }
            } catch {
              // skip malformed SSE payload
            }
          }
        }
      }
      yield* flushToolCalls();
      yield { delta: '', done: true, finishReason: 'stop', usage: finalUsage };
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
            code: 'openai_compat_stream_failed',
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

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id: string = 'openai-compatible-embedding';
  readonly name: string = 'OpenAI-compatible Embeddings';
  readonly dimension: number;
  readonly model: string;

  private status: ProviderStatus = { state: 'handshaking' };
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(cfg: OpenAICompatEmbeddingConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
    this.model = cfg.model;
    this.dimension = cfg.dimension;
    this.apiKey = cfg.apiKey;
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  async healthCheck(): Promise<ProviderStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: authHeaders(this.apiKey),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.status = { state: 'ready', lastReadyAt: now() };
    } catch (e) {
      this.status = {
        state: 'failed',
        lastError: {
          code: 'openai_compat_unreachable',
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
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: authHeaders(this.apiKey),
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    const out = [...body.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
    for (const v of out) {
      if (v.length !== this.dimension) {
        throw new Error(
          `Embedding dimension mismatch: got ${v.length}, declared ${this.dimension}`
        );
      }
    }
    return out;
  }

  async dispose(): Promise<void> {
    this.status = { state: 'stopped' };
  }
}
