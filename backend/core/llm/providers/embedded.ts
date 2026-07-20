/**
 * Embedded provider — llama.cpp in-process (régression réparée).
 *
 * Historique : le routage `'ollama' | 'embedded' | 'auto'` vivait dans
 * `LLMProviderManager`, supprimé le 2026-04-25 (commit 6063021) au motif que
 * ses consommateurs avaient migré vers le `ProviderRegistry` typé. La
 * migration n'a jamais reporté la branche « embedded » : le catalogue, les
 * téléchargements et la section de réglages ont survécu, mais plus rien
 * n'instanciait `EmbeddedLLMClient`. Choisir « embarqué » n'avait donc aucun
 * effet — invisible tant qu'Ollama tournait, ce qui explique que la
 * régression ait passé plusieurs mois inaperçue.
 *
 * Ce module rebranche le client sous la forme qu'attend le registre : deux
 * adaptateurs implémentant `LLMProvider` et `EmbeddingProvider`, sans toucher
 * à `base.ts`.
 *
 * Le chargement d'un GGUF est lent (plusieurs secondes) et se fait en
 * mémoire : l'état `spawning` couvre le chargement, `ready` l'après. Le
 * chargement est paresseux — construire le provider ne charge rien, ce qui
 * permet au registre de le fabriquer sans coût quand il ne sert pas.
 */

import { EmbeddedLLMClient } from '../EmbeddedLLMClient.js';
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

export interface EmbeddedProviderConfig {
  /** Chemin absolu du fichier GGUF (config `llm.embeddedModelPath`). */
  modelPath?: string;
  /** Identifiant catalogue (`qwen2.5-0.5b`…), pour l'affichage et les préfixes. */
  modelId?: string;
  /** Injection de test : évite de charger 500 Mo de GGUF en CI. */
  client?: EmbeddedLLMClient;
}

export interface EmbeddedEmbeddingProviderConfig extends EmbeddedProviderConfig {
  /** Dimension déclarée ; la valeur réelle du modèle prime après chargement. */
  dimension: number;
}

function now(): string {
  return new Date().toISOString();
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Partie commune aux deux adaptateurs : un client chargé au plus tard,
 * une seule fois, avec l'échec mémorisé dans la machine à états.
 */
abstract class EmbeddedBase {
  protected status: ProviderStatus = { state: 'unconfigured' };
  protected readonly client: EmbeddedLLMClient;
  protected readonly modelPath?: string;
  protected readonly modelId?: string;
  private loading: Promise<boolean> | null = null;

  constructor(cfg: EmbeddedProviderConfig) {
    this.client = cfg.client ?? new EmbeddedLLMClient();
    this.modelPath = cfg.modelPath;
    this.modelId = cfg.modelId;
    // Sans chemin de modèle il n'y a rien à charger : `unconfigured` est
    // l'état exact, et il distingue « pas de modèle téléchargé » d'un échec.
    this.status = cfg.modelPath
      ? { state: 'handshaking' }
      : {
          state: 'unconfigured',
          lastError: {
            code: 'embedded_model_missing',
            message:
              'No embedded model configured. Download one from Settings → Embedded LLM.',
            at: now(),
          },
        };
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  /** Charge le modèle si besoin ; jamais deux fois en parallèle. */
  protected async ensureLoaded(): Promise<boolean> {
    if (!this.modelPath) return false;
    if (this.loading) return this.loading;
    this.status = { state: 'spawning' };
    this.loading = this.load()
      .then((ok) => {
        this.status = ok
          ? { state: 'ready', lastReadyAt: now() }
          : {
              state: 'failed',
              lastError: {
                code: 'embedded_load_failed',
                message: `Could not load embedded model from ${this.modelPath}`,
                at: now(),
              },
            };
        // Un échec doit pouvoir être retenté (modèle re-téléchargé, mémoire
        // libérée) : on ne mémorise que le succès.
        if (!ok) this.loading = null;
        return ok;
      })
      .catch((e: unknown) => {
        this.status = {
          state: 'failed',
          lastError: {
            code: 'embedded_load_failed',
            message: message(e),
            at: now(),
          },
        };
        this.loading = null;
        return false;
      });
    return this.loading;
  }

  protected abstract load(): Promise<boolean>;
}

export class EmbeddedProvider extends EmbeddedBase implements LLMProvider {
  readonly id = 'embedded';
  readonly name = 'Embedded (llama.cpp)';
  readonly model: string;

  /**
   * `tools: false` — llama.cpp est servi ici sans couche d'appel d'outils.
   * Le prétendre ferait boucler la boucle d'agent sur des réponses qui ne
   * contiennent jamais de `tool_calls`.
   */
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    tools: false,
    embeddings: false,
  };

  constructor(cfg: EmbeddedProviderConfig) {
    super(cfg);
    this.model = cfg.modelId ?? 'embedded';
  }

  protected async load(): Promise<boolean> {
    return this.client.initialize(this.modelPath as string, this.modelId);
  }

  async healthCheck(): Promise<ProviderStatus> {
    await this.ensureLoaded();
    return this.status;
  }

  /**
   * Contrat `base.ts` : au moins un chunk avec `done:true`, y compris en
   * erreur, et aucun `throw` une fois le flux commencé.
   */
  async *chat(
    messages: ChatMessage[],
    opts: ChatOptions = {}
  ): AsyncIterable<ChatChunk> {
    const ready = await this.ensureLoaded();
    if (!ready) {
      yield { delta: '', done: true, finishReason: 'error' };
      return;
    }

    // `EmbeddedLLMClient` prend un prompt et un system prompt séparés : on
    // aplatit la conversation en préservant les tours, le modèle voyant
    // ensuite le format ChatML qu'il attend.
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const turns = messages.filter((m) => m.role !== 'system');
    const last = turns[turns.length - 1];
    const history = turns
      .slice(0, -1)
      .map((m) => `${m.role === 'user' ? 'Question' : 'Réponse'} : ${m.content}`);

    let emitted = false;
    try {
      for await (const delta of this.client.generateResponseStream(
        last?.content ?? '',
        history,
        system || undefined
      )) {
        if (opts.signal?.aborted) {
          yield { delta: '', done: true, finishReason: 'cancelled' };
          return;
        }
        emitted = true;
        yield { delta };
      }
      yield { delta: '', done: true, finishReason: 'stop' };
    } catch (e) {
      // Le flux a peut-être déjà produit du texte : on termine proprement
      // plutôt que de propager, comme l'exige le contrat.
      this.status = {
        state: 'degraded',
        lastError: {
          code: 'embedded_generation_failed',
          message: message(e),
          at: now(),
        },
      };
      yield {
        delta: '',
        done: true,
        finishReason: opts.signal?.aborted ? 'cancelled' : 'error',
      };
      if (!emitted) return;
    }
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    let out = '';
    for await (const chunk of this.chat([{ role: 'user', content: prompt }], opts)) {
      out += chunk.delta;
    }
    return out;
  }

  async dispose(): Promise<void> {
    try {
      await this.client.dispose();
    } finally {
      this.status = { state: 'stopped' };
    }
  }
}

export class EmbeddedEmbeddingProvider
  extends EmbeddedBase
  implements EmbeddingProvider
{
  readonly id = 'embedded-embedding';
  readonly name = 'Embedded Embeddings (llama.cpp)';
  readonly model: string;
  private declaredDimension: number;

  constructor(cfg: EmbeddedEmbeddingProviderConfig) {
    super(cfg);
    this.model = cfg.modelId ?? 'embedded-embedding';
    this.declaredDimension = cfg.dimension;
  }

  /**
   * Dimension réelle du modèle une fois chargé, déclarée sinon. Un index
   * vectoriel construit sur une dimension et interrogé sur une autre est
   * silencieusement faux : la valeur du modèle prime dès qu'elle existe.
   */
  get dimension(): number {
    const live = this.client.getEmbeddingDimensions();
    return live > 0 ? live : this.declaredDimension;
  }

  protected async load(): Promise<boolean> {
    return this.client.initializeEmbedding(this.modelPath as string, this.modelId);
  }

  async healthCheck(): Promise<ProviderStatus> {
    await this.ensureLoaded();
    return this.status;
  }

  async embed(
    texts: string[],
    opts: { signal?: AbortSignal } = {}
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    const ready = await this.ensureLoaded();
    if (!ready) {
      throw new Error(
        this.status.lastError?.message ?? 'Embedded embedding model unavailable'
      );
    }

    const out: number[][] = [];
    for (const text of texts) {
      if (opts.signal?.aborted) throw new Error('Embedding cancelled');
      const vec = await this.client.generateEmbedding(text);
      out.push(Array.from(vec));
    }
    return out;
  }

  async dispose(): Promise<void> {
    try {
      await this.client.dispose();
    } finally {
      this.status = { state: 'stopped' };
    }
  }
}
