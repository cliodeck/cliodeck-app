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
 *
 * L'événement s'émet à la fin de l'appel, mais porte la racine du projet lue à son début
 * (`originWorkspaceRoot`) : un appel fini après l'ouverture d'un autre projet n'entre pas dans
 * le journal de celui-ci (S10-1-33).
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
import {
  getJournalContext,
  originWorkspaceRoot,
  recordInference,
} from '../../usage-journal/context.js';
import { isLocalProvider } from '../../usage-journal/is-local.js';
import { resolveEmbeddingProvider } from './fallback.js';

/** Estimation grossière de tokens quand l'API n'en fournit pas (~4 caractères/token). */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

class InstrumentedLLM implements LLMProvider {
  private readonly isLocal: boolean;

  constructor(
    private readonly inner: LLMProvider,
    private readonly providerId: string,
    baseUrl?: string
  ) {
    this.isLocal = isLocalProvider(providerId, baseUrl, inner.model);
  }

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
    const workspaceRoot = originWorkspaceRoot();
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
      this.emitCompletion(start, workspaceRoot, promptChars, completionChars, usage, errored);
    }
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    // Les providers implémentent complete() en consommant leur propre chat() et
    // jettent l'usage ; on reproduit ce comportement mais on capture les tokens.
    const start = Date.now();
    const workspaceRoot = originWorkspaceRoot();
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
      this.emitCompletion(start, workspaceRoot, promptChars, out.length, usage, errored);
    }
    return out;
  }

  private emitCompletion(
    startMs: number,
    workspaceRoot: string | undefined,
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
      isLocal: this.isLocal,
      workspaceRoot,
    });
  }
}

class InstrumentedEmbedding implements EmbeddingProvider {
  private readonly isLocal: boolean;

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly providerId: string,
    private readonly baseUrl?: string
  ) {
    this.isLocal = isLocalProvider(providerId, baseUrl, inner.model);
  }

  /**
   * Repli enveloppé : le fournisseur choisi, enveloppé à son tour. Le déballer contournerait le
   * journal ; ne pas exposer `resolve` laissait un cache rangé par modèle lire la clé du dernier
   * choix, pas celle du modèle qui produira le vecteur.
   */
  async resolve(): Promise<EmbeddingProvider> {
    const chosen = await resolveEmbeddingProvider(this.inner);
    return chosen === this.inner ? this : new InstrumentedEmbedding(chosen, this.providerId, this.baseUrl);
  }

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
    const workspaceRoot = originWorkspaceRoot();
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
        ctx.batch.isLocal ??= this.isLocal;
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
          isLocal: this.isLocal,
          workspaceRoot,
        });
      }
    }
  }
}

export function instrumentLLM(
  inner: LLMProvider,
  providerId: string,
  baseUrl?: string
): LLMProvider {
  return new InstrumentedLLM(inner, providerId, baseUrl);
}

export function instrumentEmbedding(
  inner: EmbeddingProvider,
  providerId: string,
  baseUrl?: string
): EmbeddingProvider {
  return new InstrumentedEmbedding(inner, providerId, baseUrl);
}
