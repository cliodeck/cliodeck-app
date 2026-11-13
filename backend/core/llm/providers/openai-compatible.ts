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
import { collectCompletion } from './collect.js';
import { readProviderError } from './provider-error.js';

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

/**
 * Modèles de raisonnement d'OpenAI : la série o et les familles gpt-5 et suivantes (S05-2-2). Ils
 * refusent `temperature` et `top_p` (GPT-6 : « When reasoning effort is not `none`, remove
 * `temperature`, `top_p` », et ClioDeck ne demande pas `none`), et `max_tokens`, remplacé par
 * `max_completion_tokens` ; le rôle `developer` y remplace `system` (« With o1 models and newer »).
 * Les séries 7 à 9 sont comprises d'avance : un modèle qui accepterait la température répond sans
 * elle, un modèle de raisonnement qui la reçoit refuse le tour. Ancré au début du nom : les modèles
 * de Mistral et des serveurs locaux ne sont pas visés.
 */
export function isOpenAIReasoningModel(model: string): boolean {
  return /^(?:o\d|gpt-[5-9])/i.test(model);
}

/**
 * Réserve de raisonnement ajoutée au budget d'un modèle de raisonnement. Pour eux,
 * `max_completion_tokens` compte le texte visible et les jetons de raisonnement, et la limite peut
 * tomber « before any visible output tokens are produced » : une étape de recette à 800 jetons
 * rendait alors un texte vide, sans erreur. Le guide du raisonnement d'OpenAI (lu le 2026-11-13)
 * recommande « reserving at least 25,000 tokens for reasoning and outputs ». Le budget demandé par
 * l'appelant reste celui du texte visible.
 */
export const OPENAI_REASONING_TOKEN_RESERVE = 25_000;

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
  readonly model: string;
  private readonly apiKey?: string;
  /** Préfixe des codes d'erreur : Mistral garde le sien, pour que le chat et le journal le nomment. */
  protected readonly errorPrefix: string = 'openai_compat';

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
          code: `${this.errorPrefix}_unreachable`,
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
    const reasoning = isOpenAIReasoningModel(model);
    const body = {
      model,
      messages: messages.map((m) => {
        const base: Record<string, unknown> = {
          role: reasoning && m.role === 'system' ? 'developer' : m.role,
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
      ...(reasoning
        ? {
            max_completion_tokens:
              opts.maxTokens === undefined
                ? undefined
                : opts.maxTokens + OPENAI_REASONING_TOKEN_RESERVE,
          }
        : { temperature: opts.temperature, top_p: opts.topP, max_tokens: opts.maxTokens }),
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
      // Abandonnée avant toute réponse (« Arrêter », fermeture du projet) : pas une panne (J9).
      if (opts.signal?.aborted) {
        yield { delta: '', done: true, finishReason: 'cancelled' };
        return;
      }
      this.status = {
        state: 'failed',
        lastError: {
          code: `${this.errorPrefix}_request_failed`,
          message: e instanceof Error ? e.message : String(e),
          at: now(),
        },
      };
      yield { delta: '', done: true, finishReason: 'error' };
      return;
    }

    // La cause est posée avant le chunk terminal : `chat-engine` lit l'état à son arrivée, puis
    // lâche le flux (S05-1-5).
    if (!res.ok || !res.body) {
      this.status = {
        state: 'degraded',
        lastError: {
          code: `${this.errorPrefix}_http_${res.status}`,
          message: res.ok ? 'Réponse sans corps' : await readProviderError(res),
          at: now(),
        },
      };
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
                error?: string | { message?: string };
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
              // Une erreur en cours de flux (`data: {"error": …}`) coupe la réponse : elle
              // n'a pas de `choices`, et passait pour un morceau vide.
              if (obj.error) {
                const message =
                  typeof obj.error === 'string' ? obj.error : obj.error.message;
                this.status = {
                  state: 'degraded',
                  lastError: {
                    code: `${this.errorPrefix}_stream_error`,
                    message: message || JSON.stringify(obj.error),
                    at: now(),
                  },
                };
                yield { delta: '', done: true, finishReason: 'error' };
                return;
              }
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
      // Fermé sans `finish_reason` ni `[DONE]` : fin normale. Les serveurs locaux (llama.cpp,
      // LM Studio…) ne sont pas fiables sur ce point ; l'exiger ferait échouer des réponses complètes.
      yield* flushToolCalls();
      yield { delta: '', done: true, finishReason: 'stop', usage: finalUsage };
    } catch (e) {
      // La cause est posée avant le chunk terminal : `chat-engine` lit l'état à son arrivée, puis
      // lâche le flux.
      const cancelled = opts.signal?.aborted;
      if (!cancelled) {
        this.status = {
          state: 'degraded',
          lastError: {
            code: `${this.errorPrefix}_stream_failed`,
            message: e instanceof Error ? e.message : String(e),
            at: now(),
          },
        };
      }
      yield {
        delta: '',
        done: true,
        finishReason: cancelled ? 'cancelled' : 'error',
      };
    }
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const { text } = await collectCompletion(
      this,
      this.chat([{ role: 'user', content: prompt }], opts)
    );
    return text;
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
