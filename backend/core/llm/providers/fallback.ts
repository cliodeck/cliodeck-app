/**
 * Fallback providers — « essaie l'un, sinon l'autre ».
 *
 * Sert la sémantique `auto` des réglages `llm.generationProvider` /
 * `llm.embeddingProvider`, reprise de l'ancien `LLMProviderManager` :
 * **Ollama d'abord, repli sur le modèle embarqué s'il est indisponible**.
 *
 * L'adaptateur de configuration est synchrone et ne peut pas sonder Ollama ;
 * la décision est donc prise ici, à l'usage, par un `healthCheck` du primaire
 * mis en cache quelques secondes. C'est ce qui permet à ClioDeck de continuer
 * à répondre quand Ollama est arrêté, sans que l'utilisateur ait à changer
 * un réglage.
 *
 * Le choix est fait **avant** le premier chunk : on ne bascule jamais au
 * milieu d'un flux, ce qui produirait une réponse cousue de deux modèles.
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

/** Durée de validité d'un sondage du primaire. */
const PROBE_TTL_MS = 15_000;

function usable(status: ProviderStatus): boolean {
  // `degraded` reste utilisable (modèle absent côté Ollama, par exemple) :
  // seul un échec franc justifie de basculer.
  return status.state === 'ready' || status.state === 'degraded';
}

class Picker<T extends { healthCheck(): Promise<ProviderStatus> }> {
  private lastProbeAt = 0;
  private lastChoice: T | null = null;

  constructor(
    private readonly primary: T,
    private readonly fallback: T,
    private readonly clock: () => number = () => Date.now()
  ) {}

  async pick(): Promise<T> {
    const nowMs = this.clock();
    if (this.lastChoice && nowMs - this.lastProbeAt < PROBE_TTL_MS) {
      return this.lastChoice;
    }
    let choice: T;
    try {
      choice = usable(await this.primary.healthCheck())
        ? this.primary
        : this.fallback;
    } catch {
      choice = this.fallback;
    }
    this.lastChoice = choice;
    this.lastProbeAt = nowMs;
    return choice;
  }

  /** Provider retenu au dernier sondage, sans en déclencher un nouveau. */
  current(): T {
    return this.lastChoice ?? this.primary;
  }
}

export class FallbackLLMProvider implements LLMProvider {
  readonly id = 'fallback';
  readonly name: string;
  private readonly picker: Picker<LLMProvider>;

  constructor(
    private readonly primary: LLMProvider,
    private readonly fallback: LLMProvider,
    clock?: () => number
  ) {
    this.name = `${primary.name} → ${fallback.name}`;
    this.picker = new Picker(primary, fallback, clock);
  }

  get model(): string {
    return this.picker.current().model;
  }

  /**
   * Capacités du dénominateur commun : annoncer les outils parce que le
   * primaire les gère ferait échouer la boucle d'agent le jour où le repli
   * sert. On n'annonce que ce qui vaut dans les deux cas.
   */
  get capabilities(): ProviderCapabilities {
    const a = this.primary.capabilities;
    const b = this.fallback.capabilities;
    return {
      chat: a.chat && b.chat,
      streaming: a.streaming && b.streaming,
      tools: a.tools && b.tools,
      embeddings: a.embeddings && b.embeddings,
    };
  }

  getStatus(): ProviderStatus {
    return this.picker.current().getStatus();
  }

  async healthCheck(): Promise<ProviderStatus> {
    const chosen = await this.picker.pick();
    return chosen.healthCheck();
  }

  async *chat(
    messages: ChatMessage[],
    opts: ChatOptions = {}
  ): AsyncIterable<ChatChunk> {
    const chosen = await this.picker.pick();
    yield* chosen.chat(messages, opts);
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const chosen = await this.picker.pick();
    return chosen.complete(prompt, opts);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.primary.dispose(), this.fallback.dispose()]);
  }
}

export class FallbackEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'fallback-embedding';
  readonly name: string;
  private readonly picker: Picker<EmbeddingProvider>;

  constructor(
    private readonly primary: EmbeddingProvider,
    private readonly fallback: EmbeddingProvider,
    clock?: () => number
  ) {
    this.name = `${primary.name} → ${fallback.name}`;
    this.picker = new Picker(primary, fallback, clock);
  }

  /**
   * ATTENTION : les deux modèles n'ont pas nécessairement la même dimension.
   * Un index construit avec l'un puis interrogé avec l'autre est
   * silencieusement faux — c'est pourquoi l'adaptateur n'assemble ce repli
   * que lorsque les dimensions concordent (cf. cliodeck-config-adapter).
   */
  get dimension(): number {
    return this.picker.current().dimension;
  }

  get model(): string {
    return this.picker.current().model;
  }

  getStatus(): ProviderStatus {
    return this.picker.current().getStatus();
  }

  async healthCheck(): Promise<ProviderStatus> {
    const chosen = await this.picker.pick();
    return chosen.healthCheck();
  }

  async embed(
    texts: string[],
    opts: { signal?: AbortSignal } = {}
  ): Promise<number[][]> {
    const chosen = await this.picker.pick();
    return chosen.embed(texts, opts);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.primary.dispose(), this.fallback.dispose()]);
  }
}
