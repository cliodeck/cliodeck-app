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
 * Le statut est l'issue réelle de l'appel, lue sur le chunk terminal : `error`, `cancelled` (abandon,
 * ni réussi ni en panne), sinon `ok`, même sans exception : le contrat de `base.ts` interdit de lever
 * une fois le flux commencé (L09-7, L09-16). Un appel tombé ou annulé sans rien produire ni annoncer
 * n'a pas de jetons : le fournisseur n'a peut-être jamais reçu le prompt (S06-2-5).
 *
 * Derrière un repli (`FallbackLLMProvider`, `FallbackEmbeddingProvider`), l'appel est au fournisseur
 * retenu, pas à celui de la configuration : le modèle embarqué qui répond ou calcule les vecteurs,
 * Ollama arrêté, n'est pas inscrit comme Ollama, et sa localité se calcule pour lui, à chaque appel
 * (S05-1-17, S10-1-11).
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
import type { InferenceStatus } from '../../usage-journal/types.js';
import { collectCompletion, ProviderCallError } from './collect.js';
import {
  embeddedTokenizerOf,
  FallbackEmbeddingProvider,
  FallbackLLMProvider,
  resolveEmbeddingProvider,
} from './fallback.js';
import type { EmbeddedTokenizer } from '../EmbeddedLLMClient.js';

/** Estimation grossière de tokens quand l'API n'en fournit pas (~4 caractères/token). */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Le statut d'un appel fini par ce chunk terminal. La limite de longueur n'est pas une panne. */
function terminalStatus(finishReason: ChatChunk['finishReason']): InferenceStatus {
  return finishReason === 'error' || finishReason === 'cancelled' ? finishReason : 'ok';
}

/** Ce chunk apporte-t-il quelque chose du modèle : texte, raisonnement ou appel d'outil ? */
function carriesOutput(chunk: ChatChunk): boolean {
  return chunk.delta.length > 0 || !!chunk.thinking || !!chunk.toolCall;
}

class InstrumentedLLM implements LLMProvider {
  constructor(
    private readonly inner: LLMProvider,
    private readonly providerId: string,
    private readonly baseUrl?: string
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
    const workspaceRoot = originWorkspaceRoot();
    const promptChars = messages.reduce((s, m) => s + m.content.length, 0);
    let completionChars = 0;
    let produced = false;
    let usage: ChatChunk['usage'];
    let status: InferenceStatus = 'ok';
    try {
      for await (const chunk of this.inner.chat(messages, opts)) {
        completionChars += chunk.delta.length;
        if (carriesOutput(chunk)) produced = true;
        if (chunk.usage) usage = chunk.usage;
        // Retenu avant le `yield` : un consommateur qui s'arrête au terminal (`collectCompletion`
        // lève dessus) ne rend pas la main à cette boucle.
        if (chunk.done) status = terminalStatus(chunk.finishReason);
        yield chunk;
      }
    } catch (err) {
      status = opts?.signal?.aborted ? 'cancelled' : 'error';
      throw err;
    } finally {
      this.emitCompletion(start, workspaceRoot, promptChars, { completionChars, produced, usage, status });
    }
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    // Les providers implémentent complete() en consommant leur propre chat() et
    // jettent l'usage ; on reproduit ce comportement mais on capture les tokens.
    // `collectCompletion` lève sur un terminal `error` ou `cancelled`, comme leurs complete().
    // Le texte et l'usage se comptent au passage, avant lui : quand il lève, ce qui a déjà été
    // produit (et facturé) reste au journal, comme pour un chat() coupé au même endroit.
    const start = Date.now();
    const workspaceRoot = originWorkspaceRoot();
    const promptChars = prompt.length;
    let completionChars = 0;
    let produced = false;
    let usage: ChatChunk['usage'];
    let status: InferenceStatus = 'ok';
    const stream = this.inner.chat([{ role: 'user', content: prompt }], opts);
    async function* tally(): AsyncIterable<ChatChunk> {
      for await (const chunk of stream) {
        completionChars += chunk.delta.length;
        if (carriesOutput(chunk)) produced = true;
        if (chunk.usage) usage = chunk.usage;
        yield chunk;
      }
    }
    try {
      return (await collectCompletion(this.inner, tally())).text;
    } catch (err) {
      // Un appel abandonné (« Arrêter », fermeture du projet) est « cancelled », pas une panne (L09-16).
      status =
        err instanceof ProviderCallError
          ? err.finishReason
          : opts?.signal?.aborted
            ? 'cancelled'
            : 'error';
      throw err;
    } finally {
      this.emitCompletion(start, workspaceRoot, promptChars, { completionChars, produced, usage, status });
    }
  }

  /**
   * Le fournisseur qui a servi l'appel : derrière un repli, celui qu'il a retenu, lu après son choix.
   */
  private servedBy(): string {
    return this.inner instanceof FallbackLLMProvider ? this.inner.activeId : this.providerId;
  }

  /**
   * Comme `FallbackLLMProvider.activeId`, à travers le décorateur : le tour lit sur lui la fenêtre
   * du modèle qui répondra (`activeLLMId`, L08-4).
   */
  get activeId(): string {
    return this.servedBy();
  }

  /**
   * Le tokeniseur du modèle embarqué qui servira l'appel, à travers le décorateur
   * (`embeddedTokenizerOf`, L08-4). Mesurer n'est pas un appel au modèle : rien au journal.
   */
  embeddedTokenizer(signal?: AbortSignal): Promise<EmbeddedTokenizer | null> {
    return embeddedTokenizerOf(this.inner, signal);
  }

  private emitCompletion(
    startMs: number,
    workspaceRoot: string | undefined,
    promptChars: number,
    outcome: {
      completionChars: number;
      produced: boolean;
      usage: ChatChunk['usage'];
      status: InferenceStatus;
    }
  ): void {
    const { completionChars, produced, usage, status } = outcome;
    const provider = this.servedBy();
    const model = this.inner.model;
    // Tombé ou annulé avant tout : rien de produit, rien d'annoncé. Ne rien compter plutôt
    // qu'estimer un prompt que le fournisseur n'a peut-être jamais reçu (S06-2-5).
    const counted = status === 'ok' || produced || usage !== undefined;
    const promptTokens = counted
      ? usage?.promptTokens ?? estimateTokens(promptChars)
      : undefined;
    const completionTokens = counted
      ? usage?.completionTokens ?? estimateTokens(completionChars)
      : undefined;
    const estimated =
      counted && (usage?.promptTokens === undefined || usage?.completionTokens === undefined);
    recordInference({
      kind: 'completion',
      provider,
      model,
      durationMs: Math.max(0, Date.now() - startMs),
      promptTokens,
      completionTokens,
      totalTokens: counted
        ? usage?.totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0)
        : undefined,
      tokensEstimated: estimated,
      status,
      isLocal: isLocalProvider(provider, this.baseUrl, model),
      workspaceRoot,
    });
  }
}

/**
 * L'identifiant de configuration (`ollama`, `embedded`) d'un fournisseur d'embeddings, tiré de son
 * identifiant de classe (`ollama-embedding`, `embedded-embedding`) : le journal inscrit le premier,
 * comme pour la génération, dont les deux identifiants se confondent.
 */
function embeddingConfigId(classId: string): string {
  return classId.replace(/-embedding$/, '');
}

class InstrumentedEmbedding implements EmbeddingProvider {
  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly providerId: string,
    private readonly baseUrl?: string
  ) {}

  /**
   * Repli enveloppé : le fournisseur choisi, enveloppé à son tour, sous son propre nom. Le déballer
   * contournerait le journal ; ne pas exposer `resolve` laissait un cache rangé par modèle lire la
   * clé du dernier choix, pas celle du modèle qui produira le vecteur.
   */
  async resolve(opts: { signal?: AbortSignal } = {}): Promise<EmbeddingProvider> {
    const chosen = await resolveEmbeddingProvider(this.inner, opts.signal);
    if (chosen === this.inner) return this;
    const { providerId, baseUrl } = this.attribution(chosen.id);
    return new InstrumentedEmbedding(chosen, providerId, baseUrl);
  }

  /**
   * À qui inscrire les vecteurs du fournisseur `classId`, retenu par un repli : le primaire garde
   * l'identifiant et l'URL de la configuration ; le secours (le modèle embarqué) prend son propre
   * identifiant, sans l'URL d'Ollama, qui ne dit rien de lui.
   */
  private attribution(classId: string): { providerId: string; baseUrl?: string } {
    const id = embeddingConfigId(classId);
    return id === this.providerId ? { providerId: this.providerId, baseUrl: this.baseUrl } : { providerId: id };
  }

  /** Le fournisseur qui a servi l'appel et sa localité : derrière un repli, lus après son choix. */
  private servedBy(): { provider: string; isLocal: boolean } {
    const { providerId, baseUrl } =
      this.inner instanceof FallbackEmbeddingProvider
        ? this.attribution(this.inner.activeId)
        : { providerId: this.providerId, baseUrl: this.baseUrl };
    return { provider: providerId, isLocal: isLocalProvider(providerId, baseUrl, this.inner.model) };
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
    let status: InferenceStatus = 'ok';
    try {
      return await this.inner.embed(texts, opts);
    } catch (err) {
      // Abandonné (« Arrêter », fermeture du projet) : ni réussi, ni en panne (J9, L09-16).
      status = opts?.signal?.aborted ? 'cancelled' : 'error';
      throw err;
    } finally {
      const { provider, isLocal } = this.servedBy();
      const ctx = getJournalContext();
      if (ctx?.batch) {
        // Indexation en masse : accumuler, ne pas émettre par chunk.
        ctx.batch.chunkCount += texts.length;
        ctx.batch.totalTokens += tokens;
        ctx.batch.provider ??= provider;
        ctx.batch.model ??= this.inner.model;
        ctx.batch.isLocal ??= isLocal;
        // Un lot ne dit que `ok` ou `error` : un abandon y compte comme une panne, comme avant.
        if (status !== 'ok') ctx.batch.anyError = true;
      } else {
        recordInference({
          kind: 'embedding',
          provider,
          model: this.inner.model,
          durationMs: Math.max(0, Date.now() - start),
          totalTokens: tokens,
          tokensEstimated: true,
          chunkCount: texts.length,
          status,
          isLocal,
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
