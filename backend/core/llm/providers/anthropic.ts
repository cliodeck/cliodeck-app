/**
 * Anthropic provider (fusion step 1.2).
 *
 * Direct HTTP impl against the Messages API — no SDK dep to keep the backend
 * lean. Stream format is SSE with `event:` + `data:` lines, distinct from
 * OpenAI's data-only SSE.
 *
 * Reference: https://docs.anthropic.com/en/api/messages-streaming
 */

import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  CompleteOptions,
  LLMProvider,
  ProviderCapabilities,
  ProviderStatus,
} from './base.js';

export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** API version header, defaults to '2023-06-01' (stable). */
  apiVersion?: string;
}

const DEFAULT_BASE = 'https://api.anthropic.com/v1';
const DEFAULT_VERSION = '2023-06-01';

function now(): string {
  return new Date().toISOString();
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

/**
 * Map cross-provider messages to Anthropic's format.
 *   - system → top-level `system` field
 *   - user / assistant → plain messages
 *   - tool → Anthropic's `user` message carrying a `tool_result` block
 *     (matches the provider's own convention for returning tool output)
 */
function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const systems: string[] = [];
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systems.push(m.content);
    } else if (m.role === 'user' || m.role === 'assistant') {
      out.push({ role: m.role, content: m.content });
    } else if (m.role === 'tool') {
      if (!m.toolCallId) continue;
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: m.content,
          },
        ],
      });
    }
  }
  return {
    system: systems.length ? systems.join('\n\n') : undefined,
    messages: out,
  };
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic';
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    tools: true,
    embeddings: false,
  };

  private status: ProviderStatus = { state: 'handshaking' };
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly apiVersion: string;

  constructor(cfg: AnthropicProviderConfig) {
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.model = cfg.model;
    this.apiKey = cfg.apiKey;
    this.apiVersion = cfg.apiVersion ?? DEFAULT_VERSION;
    if (!cfg.apiKey) {
      this.status = {
        state: 'unconfigured',
        lastError: {
          code: 'anthropic_no_api_key',
          message: 'Missing Anthropic API key',
          at: now(),
        },
      };
    }
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.apiVersion,
    };
  }

  async healthCheck(): Promise<ProviderStatus> {
    if (!this.apiKey) {
      this.status = {
        state: 'unconfigured',
        lastError: {
          code: 'anthropic_no_api_key',
          message: 'Missing Anthropic API key',
          at: now(),
        },
      };
      return this.status;
    }
    try {
      // Cheapest authenticated ping: 1-token completion.
      const res = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      this.status = { state: 'ready', lastReadyAt: now() };
    } catch (e) {
      this.status = {
        state: 'failed',
        lastError: {
          code: 'anthropic_unreachable',
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
    const { system, messages: msgs } = toAnthropicMessages(messages);
    const tools = opts.tools?.length
      ? opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }))
      : undefined;
    const body = {
      model: opts.model ?? this.model,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature,
      top_p: opts.topP,
      top_k: opts.topK,
      stop_sequences: opts.stop,
      stream: true,
      ...(system ? { system } : {}),
      ...(tools ? { tools } : {}),
      messages: msgs,
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (e) {
      this.status = {
        state: 'failed',
        lastError: {
          code: 'anthropic_request_failed',
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

    // Track partial tool_use blocks — Anthropic streams the name in
    // content_block_start and accumulates arguments across
    // input_json_delta events, flushed on content_block_stop.
    const pendingToolUse = new Map<
      number,
      { id: string; name: string; argsJson: string }
    >();

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
              type: string;
              index?: number;
              content_block?: {
                type?: string;
                id?: string;
                name?: string;
              };
              delta?: {
                type?: string;
                text?: string;
                partial_json?: string;
                stop_reason?: string;
              };
              message?: {
                usage?: { input_tokens?: number; output_tokens?: number };
              };
              usage?: { output_tokens?: number };
            };
            if (
              obj.type === 'content_block_start' &&
              obj.content_block?.type === 'tool_use' &&
              obj.content_block.id &&
              obj.content_block.name &&
              obj.index != null
            ) {
              pendingToolUse.set(obj.index, {
                id: obj.content_block.id,
                name: obj.content_block.name,
                argsJson: '',
              });
            } else if (
              obj.type === 'content_block_delta' &&
              obj.delta?.type === 'input_json_delta' &&
              obj.index != null
            ) {
              const p = pendingToolUse.get(obj.index);
              if (p && obj.delta.partial_json) {
                p.argsJson += obj.delta.partial_json;
              }
            } else if (obj.type === 'content_block_delta' && obj.delta?.text) {
              yield { delta: obj.delta.text };
            } else if (obj.type === 'content_block_stop' && obj.index != null) {
              const p = pendingToolUse.get(obj.index);
              if (p) {
                yield {
                  delta: '',
                  toolCall: {
                    id: p.id,
                    name: p.name,
                    arguments: p.argsJson || '{}',
                  },
                };
                pendingToolUse.delete(obj.index);
              }
            } else if (obj.type === 'message_delta') {
              if (obj.delta?.stop_reason) {
                const r = obj.delta.stop_reason;
                finishReason =
                  r === 'tool_use'
                    ? 'tool_call'
                    : r === 'max_tokens'
                      ? 'length'
                      : 'stop';
              }
              if (obj.usage?.output_tokens != null) {
                usage = {
                  ...(usage ?? {}),
                  completionTokens: obj.usage.output_tokens,
                };
              }
            } else if (obj.type === 'message_start' && obj.message?.usage) {
              usage = {
                promptTokens: obj.message.usage.input_tokens,
                completionTokens: obj.message.usage.output_tokens,
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
            code: 'anthropic_stream_failed',
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
