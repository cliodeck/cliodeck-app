/**
 * Hook du journal d'usage IA — décorateurs des providers.
 *
 * Posés dans `ProviderRegistry.getLLM()/getEmbedding()`, ils enveloppent tout appel
 * de complétion (`chat`, `complete`) et d'embedding (`embed`) — point de passage
 * unique de l'app, y compris CLI et recipes. Best-effort : si aucun sink n'est
 * enregistré (journal non initialisé), les décorateurs sont des pass-through inertes.
 *
 * Deux subtilités traitées ici (voir `docs/journal-usage-ia-reperage.md`) :
 *  - `EmbeddingProvider.embed()` ne renvoie jamais d'usage → tokens estimés (chars/4) ;
 *  - `LLMProvider.complete()` jette l'usage dans tous les providers → on ré-implémente
 *    `complete()` en consommant le `chat()` interne pour récupérer les tokens.
 *
 * Agrégation des indexations en masse : à l'intérieur d'un scope `runBatch`, `embed()`
 * accumule dans le contexte au lieu d'émettre un événement par chunk.
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
import { getJournalContext, recordInference } from '../../usage-journal/context.js';

/** Estimation grossière de tokens quand l'API n'en fournit pas (~4 caractères/token). */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

class InstrumentedLLM implements LLMProvider {
  constructor(
    private readonly inner: LLMProvider,
    private readonly providerId: string
  ) {}

  get id(): string {
    return this.inner.id;
  }
  get name(): string {
    return this.inner.name;
  }
  get model(): string {
    return this.inner.model;
  }
  get capabilities(): ProviderCapabilities {
    return this.inner.capabilities;
  }

  getStatus(): ProviderStatus {
    return this.inner.getStatus();
  }
  healthCheck(): Promise<ProviderStatus> {
    return this.inner.healthCheck();
  }
  dispose(): Promise<void> {
    return this.inner.dispose();
  }

  async *chat(
    messages: ChatMessage[],
    opts?: ChatOptions
  ): AsyncIterable<ChatChunk> {
    const start = Date.now();
    const promptChars = messages.reduce((s, m) => s + m.content.length, 0);
    let completionChars = 0;
    let usage: ChatChunk['usage'];
    let errored = false;
    try {
      for await (const chunk of this.inner.chat(messages, opts)) {
        completionChars += chunk.delta.length;
        if (chunk.usage) usage = chunk.usage;
        yield chunk;
      }
    } catch (err) {
      errored = true;
      throw err;
    } finally {
      this.emitCompletion(start, promptChars, completionChars, usage, errored);
    }
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    // Les providers implémentent complete() en consommant leur propre chat() et
    // jettent l'usage ; on reproduit ce comportement mais on capture les tokens.
    const start = Date.now();
    const promptChars = prompt.length;
    let out = '';
    let usage: ChatChunk['usage'];
    let errored = false;
    try {
      for await (const chunk of this.inner.chat(
        [{ role: 'user', content: prompt }],
        opts
      )) {
        out += chunk.delta;
        if (chunk.usage) usage = chunk.usage;
      }
    } catch (err) {
      errored = true;
      throw err;
    } finally {
      this.emitCompletion(start, promptChars, out.length, usage, errored);
    }
    return out;
  }

  private emitCompletion(
    startMs: number,
    promptChars: number,
    completionChars: number,
    usage: ChatChunk['usage'],
    errored: boolean
  ): void {
    const promptTokens = usage?.promptTokens ?? estimateTokens(promptChars);
    const completionTokens =
      usage?.completionTokens ?? estimateTokens(completionChars);
    const estimated =
      usage?.promptTokens === undefined || usage?.completionTokens === undefined;
    recordInference({
      kind: 'completion',
      provider: this.providerId,
      model: this.inner.model,
      durationMs: Math.max(0, Date.now() - startMs),
      promptTokens,
      completionTokens,
      totalTokens: usage?.totalTokens ?? promptTokens + completionTokens,
      tokensEstimated: estimated,
      status: errored ? 'error' : 'ok',
    });
  }
}

class InstrumentedEmbedding implements EmbeddingProvider {
  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly providerId: string
  ) {}

  get id(): string {
    return this.inner.id;
  }
  get name(): string {
    return this.inner.name;
  }
  get dimension(): number {
    return this.inner.dimension;
  }
  get model(): string {
    return this.inner.model;
  }

  getStatus(): ProviderStatus {
    return this.inner.getStatus();
  }
  healthCheck(): Promise<ProviderStatus> {
    return this.inner.healthCheck();
  }
  dispose(): Promise<void> {
    return this.inner.dispose();
  }

  async embed(
    texts: string[],
    opts?: { signal?: AbortSignal }
  ): Promise<number[][]> {
    const start = Date.now();
    const tokens = texts.reduce((s, t) => s + estimateTokens(t.length), 0);
    let errored = false;
    try {
      return await this.inner.embed(texts, opts);
    } catch (err) {
      errored = true;
      throw err;
    } finally {
      const ctx = getJournalContext();
      if (ctx?.batch) {
        // Indexation en masse : accumuler, ne pas émettre par chunk.
        ctx.batch.chunkCount += texts.length;
        ctx.batch.totalTokens += tokens;
        ctx.batch.provider ??= this.providerId;
        ctx.batch.model ??= this.inner.model;
        if (errored) ctx.batch.anyError = true;
      } else {
        recordInference({
          kind: 'embedding',
          provider: this.providerId,
          model: this.inner.model,
          durationMs: Math.max(0, Date.now() - start),
          totalTokens: tokens,
          tokensEstimated: true,
          chunkCount: texts.length,
          status: errored ? 'error' : 'ok',
        });
      }
    }
  }
}

export function instrumentLLM(inner: LLMProvider, providerId: string): LLMProvider {
  return new InstrumentedLLM(inner, providerId);
}

export function instrumentEmbedding(
  inner: EmbeddingProvider,
  providerId: string
): EmbeddingProvider {
  return new InstrumentedEmbedding(inner, providerId);
}
