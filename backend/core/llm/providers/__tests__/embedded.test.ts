/**
 * Modèle embarqué — adaptateurs, repli, résolution des réglages.
 *
 * Le test le plus important de ce fichier est le dernier : il échoue si le
 * registre reperd son entrée `embedded`. C'est exactement ce qui s'est produit
 * en avril 2026 — la suppression de `LLMProviderManager` a emporté le routage
 * sans qu'aucun test ne s'en aperçoive, parce qu'Ollama tournait partout et
 * masquait la panne.
 *
 * Aucun GGUF n'est chargé ici : `EmbeddedLLMClient` est injecté sous forme de
 * double. Le chargement réel est vérifié par le script d'inférence hors app.
 */

import { describe, it, expect } from 'vitest';
import { EmbeddedProvider, EmbeddedEmbeddingProvider } from '../embedded.js';
import { FallbackLLMProvider, FallbackEmbeddingProvider } from '../fallback.js';
import { clioDeckConfigToRegistryConfig } from '../cliodeck-config-adapter.js';
import type { EmbeddedLLMClient } from '../../EmbeddedLLMClient.js';
import type {
  ChatChunk,
  EmbeddingProvider,
  LLMProvider,
  ProviderStatus,
} from '../base.js';
import type { LLMConfig as ClioDeckLLMConfig } from '../../../../types/config.js';

/** Double de client : aucun accès disque, aucun natif. */
function fakeClient(opts: {
  loads?: boolean;
  deltas?: string[];
  throwsOn?: 'load' | 'stream';
  dims?: number;
}): EmbeddedLLMClient {
  const { loads = true, deltas = ['bon', 'jour'], dims = 768 } = opts;
  const client = {
    async initialize() {
      if (opts.throwsOn === 'load') throw new Error('boom');
      return loads;
    },
    async initializeEmbedding() {
      if (opts.throwsOn === 'load') throw new Error('boom');
      return loads;
    },
    isAvailable: () => loads,
    isEmbeddingAvailable: () => loads,
    getEmbeddingDimensions: () => (loads ? dims : 0),
    async generateEmbedding() {
      return new Float32Array(dims).fill(0.1);
    },
    async *generateResponseStream() {
      if (opts.throwsOn === 'stream') throw new Error('generation exploded');
      for (const d of deltas) yield d;
    },
    async dispose() {},
  };
  return client as unknown as EmbeddedLLMClient;
}

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

const MODEL_PATH = '/tmp/does-not-need-to-exist.gguf';

describe('EmbeddedProvider', () => {
  it('reste unconfigured sans chemin de modèle, et le dit', () => {
    const p = new EmbeddedProvider({ client: fakeClient({}) });
    expect(p.getStatus().state).toBe('unconfigured');
    expect(p.getStatus().lastError?.code).toBe('embedded_model_missing');
  });

  it('ne charge rien à la construction (le GGUF coûte plusieurs secondes)', () => {
    const p = new EmbeddedProvider({
      modelPath: MODEL_PATH,
      client: fakeClient({}),
    });
    expect(p.getStatus().state).toBe('handshaking');
  });

  it('passe à ready après chargement', async () => {
    const p = new EmbeddedProvider({
      modelPath: MODEL_PATH,
      modelId: 'qwen2.5-0.5b',
      client: fakeClient({}),
    });
    const s = await p.healthCheck();
    expect(s.state).toBe('ready');
  });

  it("n'annonce pas les outils : llama.cpp est servi ici sans couche d'appel", () => {
    const p = new EmbeddedProvider({ modelPath: MODEL_PATH, client: fakeClient({}) });
    expect(p.capabilities.tools).toBe(false);
    expect(p.capabilities.chat).toBe(true);
  });

  it('diffuse le texte puis termine par done:true', async () => {
    const p = new EmbeddedProvider({
      modelPath: MODEL_PATH,
      client: fakeClient({ deltas: ['Salut', ' !'] }),
    });
    const chunks = await collect(p.chat([{ role: 'user', content: 'coucou' }]));
    expect(chunks.map((c) => c.delta).join('')).toBe('Salut !');
    expect(chunks[chunks.length - 1].done).toBe(true);
    expect(chunks[chunks.length - 1].finishReason).toBe('stop');
  });

  // Contrat base.ts : jamais de throw une fois le flux commencé.
  it('échec de chargement → un chunk done:true en erreur, sans exception', async () => {
    const p = new EmbeddedProvider({
      modelPath: MODEL_PATH,
      client: fakeClient({ loads: false }),
    });
    const chunks = await collect(p.chat([{ role: 'user', content: 'x' }]));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].done).toBe(true);
    expect(chunks[0].finishReason).toBe('error');
    expect(p.getStatus().state).toBe('failed');
  });

  it("exception pendant la génération → done:true en erreur, sans propagation", async () => {
    const p = new EmbeddedProvider({
      modelPath: MODEL_PATH,
      client: fakeClient({ throwsOn: 'stream' }),
    });
    const chunks = await collect(p.chat([{ role: 'user', content: 'x' }]));
    expect(chunks[chunks.length - 1].done).toBe(true);
    expect(chunks[chunks.length - 1].finishReason).toBe('error');
  });

  it('un échec de chargement peut être retenté (modèle re-téléchargé)', async () => {
    let attempts = 0;
    const flaky = {
      ...fakeClient({}),
      async initialize() {
        attempts += 1;
        return attempts > 1;
      },
    } as unknown as EmbeddedLLMClient;
    const p = new EmbeddedProvider({ modelPath: MODEL_PATH, client: flaky });
    expect((await p.healthCheck()).state).toBe('failed');
    expect((await p.healthCheck()).state).toBe('ready');
  });
});

describe('EmbeddedEmbeddingProvider', () => {
  it('la dimension réelle du modèle prime sur la dimension déclarée', async () => {
    const p = new EmbeddedEmbeddingProvider({
      modelPath: MODEL_PATH,
      dimension: 384, // déclaration erronée
      client: fakeClient({ dims: 768 }),
    });
    await p.healthCheck();
    expect(p.dimension).toBe(768);
  });

  it('produit un vecteur par texte', async () => {
    const p = new EmbeddedEmbeddingProvider({
      modelPath: MODEL_PATH,
      dimension: 768,
      client: fakeClient({}),
    });
    const out = await p.embed(['a', 'b']);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(768);
  });

  it('échoue franchement si le modèle ne charge pas (un index muet serait pire)', async () => {
    const p = new EmbeddedEmbeddingProvider({
      modelPath: MODEL_PATH,
      dimension: 768,
      client: fakeClient({ loads: false }),
    });
    await expect(p.embed(['a'])).rejects.toThrow();
  });
});

/** Provider minimal pour piloter le repli sans dépendance réseau. */
function stubLLM(state: ProviderStatus['state'], tag: string): LLMProvider {
  return {
    id: tag,
    name: tag,
    model: tag,
    capabilities: { chat: true, streaming: true, tools: tag === 'ollama', embeddings: false },
    getStatus: () => ({ state }),
    healthCheck: async () => ({ state }),
    async *chat() {
      yield { delta: tag };
      yield { delta: '', done: true, finishReason: 'stop' as const };
    },
    complete: async () => tag,
    dispose: async () => {},
  };
}

function stubEmbedding(state: ProviderStatus['state'], tag: string): EmbeddingProvider {
  return {
    id: tag,
    name: tag,
    model: tag,
    dimension: 768,
    getStatus: () => ({ state }),
    healthCheck: async () => ({ state }),
    embed: async (texts) => texts.map(() => [1, 2, 3]),
    dispose: async () => {},
  };
}

describe('repli auto', () => {
  it('utilise le primaire quand il répond', async () => {
    const p = new FallbackLLMProvider(
      stubLLM('ready', 'ollama'),
      stubLLM('ready', 'embedded')
    );
    const chunks = await collect(p.chat([{ role: 'user', content: 'x' }]));
    expect(chunks[0].delta).toBe('ollama');
  });

  // Le cœur de la promesse « ça continue de marcher hors ligne ».
  it('bascule sur l’embarqué quand Ollama est éteint', async () => {
    const p = new FallbackLLMProvider(
      stubLLM('failed', 'ollama'),
      stubLLM('ready', 'embedded')
    );
    const chunks = await collect(p.chat([{ role: 'user', content: 'x' }]));
    expect(chunks[0].delta).toBe('embedded');
  });

  it('bascule aussi quand le sondage du primaire lève', async () => {
    const broken = {
      ...stubLLM('ready', 'ollama'),
      healthCheck: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const p = new FallbackLLMProvider(broken, stubLLM('ready', 'embedded'));
    expect(await p.complete('x')).toBe('embedded');
  });

  it('degraded reste utilisable : on ne bascule que sur un échec franc', async () => {
    const p = new FallbackLLMProvider(
      stubLLM('degraded', 'ollama'),
      stubLLM('ready', 'embedded')
    );
    expect(await p.complete('x')).toBe('ollama');
  });

  it("n'annonce que les capacités communes aux deux moteurs", () => {
    const p = new FallbackLLMProvider(
      stubLLM('ready', 'ollama'), // tools: true
      stubLLM('ready', 'embedded') // tools: false
    );
    expect(p.capabilities.tools).toBe(false);
  });

  it('les embeddings basculent aussi', async () => {
    const p = new FallbackEmbeddingProvider(
      stubEmbedding('failed', 'ollama'),
      stubEmbedding('ready', 'embedded')
    );
    await p.healthCheck();
    expect(p.model).toBe('embedded');
  });
});

const baseCfg = (over: Partial<ClioDeckLLMConfig> = {}): ClioDeckLLMConfig =>
  ({
    backend: 'ollama',
    ollamaURL: 'http://localhost:11434',
    ollamaChatModel: 'llama3.2',
    ollamaEmbeddingModel: 'nomic-embed-text',
    ...over,
  }) as ClioDeckLLMConfig;

describe('résolution des réglages (cliodeck-config-adapter)', () => {
  it('embedded explicite → provider embarqué, chemin GGUF transmis', () => {
    const r = clioDeckConfigToRegistryConfig(
      baseCfg({
        generationProvider: 'embedded',
        embeddedModelId: 'qwen2.5-0.5b',
        embeddedModelPath: MODEL_PATH,
      })
    );
    expect(r.llm.provider).toBe('embedded');
    expect(r.llm.modelPath).toBe(MODEL_PATH);
    expect(r.llm.model).toBe('qwen2.5-0.5b');
  });

  it('embedded demandé sans modèle téléchargé → Ollama, pas un provider mort', () => {
    const r = clioDeckConfigToRegistryConfig(
      baseCfg({ generationProvider: 'embedded' })
    );
    expect(r.llm.provider).toBe('ollama');
  });

  it('ollama explicite → aucun repli embarqué même si un modèle est présent', () => {
    const r = clioDeckConfigToRegistryConfig(
      baseCfg({ generationProvider: 'ollama', embeddedModelPath: MODEL_PATH })
    );
    expect(r.llm.provider).toBe('ollama');
    expect(r.llm.fallback).toBeUndefined();
  });

  it('auto avec modèle téléchargé → Ollama primaire, embarqué en repli', () => {
    const r = clioDeckConfigToRegistryConfig(
      baseCfg({ generationProvider: 'auto', embeddedModelPath: MODEL_PATH })
    );
    expect(r.llm.provider).toBe('ollama');
    expect(r.llm.fallback?.provider).toBe('embedded');
  });

  it('auto sans modèle téléchargé → Ollama seul', () => {
    const r = clioDeckConfigToRegistryConfig(baseCfg({ generationProvider: 'auto' }));
    expect(r.llm.fallback).toBeUndefined();
  });

  it('un backend cloud garde la main sur la génération', () => {
    const r = clioDeckConfigToRegistryConfig(
      baseCfg({
        backend: 'claude',
        claudeAPIKey: 'sk-test',
        generationProvider: 'embedded',
        embeddedModelPath: MODEL_PATH,
      })
    );
    expect(r.llm.provider).toBe('anthropic');
  });

  it('embeddings embarqués explicites', () => {
    const r = clioDeckConfigToRegistryConfig(
      baseCfg({
        embeddingProvider: 'embedded',
        embeddedEmbeddingModelPath: MODEL_PATH,
        embeddedEmbeddingModelId: 'nomic-embed-text-v2',
      })
    );
    expect(r.embedding.provider).toBe('embedded');
    expect(r.embedding.modelPath).toBe(MODEL_PATH);
  });

  // Un index construit en 768 puis interrogé en 1024 est silencieusement faux.
  it('pas de repli embarqué si les dimensions divergent', () => {
    const r = clioDeckConfigToRegistryConfig(
      baseCfg({
        ollamaEmbeddingModel: 'mxbai-embed-large', // 1024
        embeddingProvider: 'auto',
        embeddedEmbeddingModelPath: MODEL_PATH, // 768
      })
    );
    expect(r.embedding.dimension).toBe(1024);
    expect(r.embedding.fallback).toBeUndefined();
  });

  it('repli embarqué quand les dimensions concordent', () => {
    const r = clioDeckConfigToRegistryConfig(
      baseCfg({
        embeddingProvider: 'auto',
        embeddedEmbeddingModelPath: MODEL_PATH,
      })
    );
    expect(r.embedding.fallback?.provider).toBe('embedded');
  });
});

describe('garde anti-régression du registre', () => {
  // Ce test est le filet qui manquait en avril 2026.
  it("le registre sait fabriquer un provider 'embedded'", async () => {
    const { ProviderRegistry } = await import('../registry.js');
    const reg = new ProviderRegistry({
      llm: { provider: 'embedded', model: 'qwen2.5-0.5b', modelPath: MODEL_PATH },
      embedding: {
        provider: 'embedded',
        model: 'nomic-embed-text-v2',
        dimension: 768,
        modelPath: MODEL_PATH,
      },
    });
    expect(() => reg.getLLM()).not.toThrow();
    expect(() => reg.getEmbedding()).not.toThrow();
  });

  it('le registre assemble le repli quand la config en porte un', async () => {
    const { ProviderRegistry } = await import('../registry.js');
    const reg = new ProviderRegistry({
      llm: {
        provider: 'ollama',
        model: 'llama3.2',
        fallback: { provider: 'embedded', model: 'qwen2.5-0.5b', modelPath: MODEL_PATH },
      },
      embedding: { provider: 'ollama', model: 'nomic-embed-text', dimension: 768 },
    });
    expect(reg.getLLM().name).toContain('→');
  });
});
