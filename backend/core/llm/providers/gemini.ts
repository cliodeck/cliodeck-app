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
import { collectCompletion } from './collect.js';
import { readProviderError } from './provider-error.js';

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

/**
 * Modèles Gemini qui réfléchissent : 2.5, 3, 4 et suivants, et les alias `gemini-…-latest`, qui
 * désignent la dernière version d'une variante (page des modèles, lue le 2026-11-13). Gemini 2.0 et
 * 1.5 ne réfléchissent pas.
 */
export function isGeminiThinkingModel(model: string): boolean {
  return /^gemini-(?:2\.5|[3-9]|[1-9]\d)/i.test(model) || /^gemini-[a-z-]+-latest$/i.test(model);
}

/**
 * Réserve de réflexion ajoutée au budget de réponse d'un modèle qui réfléchit. `maxOutputTokens`
 * compte les jetons de pensée (« including thought tokens »), et une limite atteinte pendant la
 * réflexion rend « truncated or empty output » avec `MAX_TOKENS`, que `collectCompletion` prend
 * pour un succès : une étape de recette à 800 jetons rendait un texte vide, sans erreur. Google ne
 * donne pas de chiffre ; 32 768 est le plus grand budget de réflexion que documente la page
 * « Thinking » (Gemini 2.5 Pro, lue le 2026-11-13). Le budget demandé reste celui du texte visible.
 */
export const GEMINI_THINKING_TOKEN_RESERVE = 32_768;

/**
 * Limite de sortie par requête des modèles qui réfléchissent : « Output token limit 65,536 » sur la
 * fiche de gemini-3.6-flash, « 64K » pour Gemini 4, et Gemini 4 Hydrogen « returns up to 65,536
 * tokens » (pages lues le 2026-11-13). La réserve ne la dépasse pas.
 */
export const GEMINI_THINKING_MAX_OUTPUT_TOKENS = 65_536;

/** Le `maxOutputTokens` envoyé pour un budget demandé (`undefined` : rien n'est envoyé). */
function maxOutputTokensFor(model: string, maxTokens: number | undefined): number | undefined {
  if (maxTokens === undefined || !isGeminiThinkingModel(model)) return maxTokens;
  return Math.min(maxTokens + GEMINI_THINKING_TOKEN_RESERVE, GEMINI_THINKING_MAX_OUTPUT_TOKENS);
}

/**
 * Signatures de pensée gardées par une instance, au plus. Google ne valide que le tour en cours
 * (« Only current turn is required ») : quelques dizaines suffisent, la borne évite seulement que la
 * table croisse sans fin sur une longue session.
 */
const MAX_KEPT_THOUGHT_SIGNATURES = 256;

type GeminiPart =
  | { text: string }
  | {
      functionCall: { name: string; args: Record<string, unknown> };
      /** Signature de pensée reçue avec cet appel, rendue telle quelle (Gemini 3 et 4). */
      thoughtSignature?: string;
    }
  | {
      functionResponse: {
        name: string;
        response: Record<string, unknown>;
      };
    };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }>;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Map ChatMessage[] to Gemini's contents + systemInstruction. Gemini accepts
 * exactly one systemInstruction; multiple system turns are concatenated.
 * Consecutive same-role messages are merged into a single content (Gemini
 * rejects two consecutive 'user' or 'model' turns).
 *
 * `signatureFor` rend la signature de pensée reçue avec un appel d'outil, par son identifiant : elle
 * revient « in the exact part where it was received », sans quoi Gemini 3 et 4 refusent la requête
 * (HTTP 400). Un appel sans signature (Gemini 2.5, appels parallèles après le premier) part sans.
 */
function toGeminiPayload(
  messages: ChatMessage[],
  signatureFor: (callId: string) => string | undefined = () => undefined
): {
  systemInstruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
} {
  const systems: string[] = [];
  const contents: GeminiContent[] = [];
  // Gemini routes tool calls/responses by *name*, not by id (no id field
  // in the protocol). We track id→name so a `tool` message can resolve
  // its responding function name correctly.
  const idToName = new Map<string, string>();

  const pushPart = (role: 'user' | 'model', part: GeminiPart): void => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(part);
    } else {
      contents.push({ role, parts: [part] });
    }
  };

  for (const m of messages) {
    if (m.role === 'system') {
      systems.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      const fnName = (m.toolCallId && idToName.get(m.toolCallId)) || m.name;
      if (!fnName) continue;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(m.content);
      } catch {
        parsed = { result: m.content };
      }
      pushPart('user', {
        functionResponse: { name: fnName, response: parsed },
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      if (m.content.trim()) {
        pushPart('model', { text: m.content });
      }
      for (const tc of m.toolCalls) {
        idToName.set(tc.id, tc.name);
        let parsed: Record<string, unknown> = {};
        try {
          parsed = tc.arguments ? JSON.parse(tc.arguments) : {};
        } catch {
          parsed = {};
        }
        const thoughtSignature = signatureFor(tc.id);
        pushPart('model', {
          functionCall: { name: tc.name, args: parsed },
          ...(thoughtSignature ? { thoughtSignature } : {}),
        });
      }
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
    pushPart(role, { text: m.content });
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
    tools: true,
    embeddings: false,
  };

  private status: ProviderStatus = { state: 'handshaking' };
  private readonly baseUrl: string;
  readonly model: string;
  private readonly apiKey: string;
  /**
   * Numéro du dernier appel d'outil reçu, sur toute la vie de l'instance : les identifiants
   * synthétiques ne se répètent pas d'un flux à l'autre, pour que la signature d'un appel ne revienne
   * pas sur un autre (deux étapes d'un même tour donnaient toutes deux `gemini-fc-1`).
   */
  private callSeq = 0;
  /** Signature de pensée reçue avec chaque appel d'outil, par identifiant synthétique. */
  private readonly thoughtSignatures = new Map<string, string>();

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
    const { systemInstruction, contents } = toGeminiPayload(messages, (id) =>
      this.thoughtSignatures.get(id)
    );
    const tools: GeminiTool[] | undefined = opts.tools?.length
      ? [
          {
            functionDeclarations: opts.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          },
        ]
      : undefined;
    const body = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(tools ? { tools } : {}),
      generationConfig: {
        temperature: opts.temperature,
        topP: opts.topP,
        topK: opts.topK,
        maxOutputTokens: maxOutputTokensFor(model, opts.maxTokens),
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
      // Abandonnée avant toute réponse (« Arrêter », fermeture du projet) : pas une panne (J9).
      if (opts.signal?.aborted) {
        yield { delta: '', done: true, finishReason: 'cancelled' };
        return;
      }
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

    // La cause est posée avant le chunk terminal : `chat-engine` lit l'état à son arrivée, puis
    // lâche le flux (S05-1-5). `readProviderError` masque la clé, passée dans l'URL.
    if (!res.ok || !res.body) {
      this.status = {
        state: 'degraded',
        lastError: {
          code: `gemini_http_${res.status}`,
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
              error?: { code?: number; message?: string; status?: string };
              candidates?: Array<{
                content?: {
                  parts?: Array<{
                    text?: string;
                    functionCall?: {
                      name?: string;
                      args?: Record<string, unknown>;
                    };
                    thoughtSignature?: string;
                  }>;
                };
                finishReason?: string;
              }>;
              usageMetadata?: {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
                totalTokenCount?: number;
              };
            };
            // Une erreur en cours de flux coupe la réponse : elle n'a pas de `candidates`, et
            // passait pour un morceau vide.
            if (obj.error) {
              this.status = {
                state: 'degraded',
                lastError: {
                  code: 'gemini_stream_error',
                  // Vide si l'API n'a rien dit : le renderer le dit dans la langue de l'interface.
                  message: obj.error.message || obj.error.status || '',
                  at: now(),
                },
              };
              yield { delta: '', done: true, finishReason: 'error' };
              return;
            }
            const cand = obj.candidates?.[0];
            const parts = cand?.content?.parts ?? [];
            for (const part of parts) {
              if (part.text) {
                yield { delta: part.text };
              } else if (part.functionCall?.name) {
                // Gemini doesn't emit a call id; synthesise a stable one
                // so downstream code can route the matching response.
                const id = `gemini-fc-${++this.callSeq}`;
                // Gemini 3 et 4 : la signature du premier appel de chaque étape doit revenir dans
                // la requête suivante du tour, sur cette même part.
                if (part.thoughtSignature) this.keepThoughtSignature(id, part.thoughtSignature);
                yield {
                  delta: '',
                  toolCall: {
                    id,
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args ?? {}),
                  },
                };
              }
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
      // La cause est posée avant le chunk terminal : `chat-engine` lit l'état à son arrivée, puis
      // lâche le flux.
      const cancelled = opts.signal?.aborted;
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
    this.thoughtSignatures.clear();
  }

  private keepThoughtSignature(id: string, signature: string): void {
    this.thoughtSignatures.set(id, signature);
    if (this.thoughtSignatures.size > MAX_KEPT_THOUGHT_SIGNATURES) {
      const oldest = this.thoughtSignatures.keys().next().value;
      if (oldest !== undefined) this.thoughtSignatures.delete(oldest);
    }
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
