/**
 * Google Gemini provider (fusion vague 2bis).
 *
 * Direct HTTP impl against the Google Generative Language v1beta API — no SDK
 * dep to keep the backend lean. Streaming uses SSE (`alt=sse`) so each `data:`
 * line is a complete JSON event. The schema differs from OpenAI/Anthropic:
 *   - assistant role is called "model"
 *   - messages live in `contents[].parts[].text`
 *   - the system prompt is a separate `systemInstruction` field
 *   - generation params live under `generationConfig`
 *
 * References:
 *   - https://ai.google.dev/api/generate-content
 *   - https://ai.google.dev/api/embeddings
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

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface GeminiEmbeddingConfig {
  apiKey: string;
  model: string;
  dimension: number;
  baseUrl?: string;
}

interface GeminiPart {
  text: string;
}
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Map ChatMessage[] to Gemini's contents + systemInstruction. Gemini accepts
 * exactly one systemInstruction; multiple system turns are concatenated.
 * Consecutive same-role messages are merged into a single content (Gemini
 * rejects two consecutive 'user' or 'model' turns).
 */
function toGeminiPayload(messages: ChatMessage[]): {
  systemInstruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
} {
  const systems: string[] = [];
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systems.push(m.content);
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text: m.content });
    } else {
      contents.push({ role, parts: [{ text: m.content }] });
    }
  }
  return {
    systemInstruction: systems.length
      ? { parts: [{ text: systems.join('\n\n') }] }
      : undefined,
    contents,
  };
}

function mapFinishReason(reason?: string): ChatChunk['finishReason'] {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case undefined:
      return 'stop';
    default:
      return 'error';
  }
}

export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini';
  readonly name = 'Google Gemini';
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    tools: false,
    embeddings: false,
  };

  private status: ProviderStatus = { state: 'handshaking' };
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;

  constructor(cfg: GeminiProviderConfig) {
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.model = cfg.model;
    this.apiKey = cfg.apiKey;
    if (!cfg.apiKey) {
      this.status = {
        state: 'unconfigured',
        lastError: {
          code: 'gemini_no_api_key',
          message: 'Missing Gemini API key',
          at: now(),
        },
      };
    }
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  async healthCheck(): Promise<ProviderStatus> {
    if (!this.apiKey) {
      this.status = {
        state: 'unconfigured',
        lastError: {
          code: 'gemini_no_api_key',
          message: 'Missing Gemini API key',
          at: now(),
        },
      };
      return this.status;
    }
    try {
      const res = await fetch(
        `${this.baseUrl}/models/${encodeURIComponent(this.model)}?key=${encodeURIComponent(this.apiKey)}`
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      this.status = { state: 'ready', lastReadyAt: now() };
    } catch (e) {
      this.status = {
        state: 'failed',
        lastError: {
          code: 'gemini_unreachable',
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
    const { systemInstruction, contents } = toGeminiPayload(messages);
    const body = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        temperature: opts.temperature,
        topP: opts.topP,
        topK: opts.topK,
        maxOutputTokens: opts.maxTokens,
        stopSequences: opts.stop,
      },
    };

    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: opts.signal,
        }
      );
    } catch (e) {
      this.status = {
        state: 'failed',
        lastError: {
          code: 'gemini_request_failed',
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
    let usage: ChatChunk['usage'] | undefined;
    let finishReason: ChatChunk['finishReason'] = 'stop';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const dataLine = event
            .split('\n')
            .find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload) continue;
          try {
            const obj = JSON.parse(payload) as {
              candidates?: Array<{
                content?: { parts?: Array<{ text?: string }> };
                finishReason?: string;
              }>;
              usageMetadata?: {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
                totalTokenCount?: number;
              };
            };
            const cand = obj.candidates?.[0];
            const text = cand?.content?.parts
              ?.map((p) => p.text ?? '')
              .join('');
            if (text) {
              yield { delta: text };
            }
            if (cand?.finishReason) {
              finishReason = mapFinishReason(cand.finishReason);
            }
            if (obj.usageMetadata) {
              usage = {
                promptTokens: obj.usageMetadata.promptTokenCount,
                completionTokens: obj.usageMetadata.candidatesTokenCount,
                totalTokens: obj.usageMetadata.totalTokenCount,
              };
            }
          } catch {
            // skip malformed SSE payload
          }
        }
      }
      yield { delta: '', done: true, finishReason, usage };
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
            code: 'gemini_stream_failed',
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

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'gemini-embedding';
  readonly name = 'Google Gemini Embeddings';
  readonly dimension: number;
  readonly model: string;

  private status: ProviderStatus = { state: 'handshaking' };
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(cfg: GeminiEmbeddingConfig) {
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.model = cfg.model;
    this.dimension = cfg.dimension;
    this.apiKey = cfg.apiKey;
    if (!cfg.apiKey) {
      this.status = {
        state: 'unconfigured',
        lastError: {
          code: 'gemini_no_api_key',
          message: 'Missing Gemini API key',
          at: now(),
        },
      };
    }
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  async healthCheck(): Promise<ProviderStatus> {
    try {
      const v = await this.embed(['ping']);
      if (v[0]?.length === this.dimension) {
        this.status = { state: 'ready', lastReadyAt: now() };
      } else {
        this.status = {
          state: 'degraded',
          lastError: {
            code: 'gemini_embedding_dim_mismatch',
            message: `Expected dimension ${this.dimension}, got ${v[0]?.length}`,
            at: now(),
          },
        };
      }
    } catch (e) {
      this.status = {
        state: 'failed',
        lastError: {
          code: 'gemini_embedding_unreachable',
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
    if (texts.length === 0) return [];
    const requests = texts.map((text) => ({
      model: `models/${this.model}`,
      content: { parts: [{ text }] },
    }));
    const res = await fetch(
      `${this.baseUrl}/models/${encodeURIComponent(this.model)}:batchEmbedContents?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests }),
        signal: opts.signal,
      }
    );
    if (!res.ok) {
      throw new Error(`Gemini embedding HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      embeddings?: Array<{ values?: number[] }>;
    };
    return (data.embeddings ?? []).map((e) => e.values ?? []);
  }

  async dispose(): Promise<void> {
    this.status = { state: 'stopped' };
  }
}
