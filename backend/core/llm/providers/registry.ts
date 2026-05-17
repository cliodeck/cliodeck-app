/**
 * Provider registry (fusion step 1.3).
 *
 * Holds the active LLM/embedding providers for the current workspace and
 * lets the rest of the backend obtain them by logical id ('llm' | 'embedding'),
 * independent of the concrete backend. Config-driven factories keep the list
 * open for future providers (OpenAI-compatible, Anthropic, Mistral…) without
 * touching call sites.
 */

import type {
  EmbeddingProvider,
  LLMProvider,
  ProviderStatus,
} from './base.js';
import {
  OllamaEmbeddingProvider,
  OllamaProvider,
  type OllamaEmbeddingProviderConfig,
  type OllamaProviderConfig,
} from './ollama.js';
import {
  OpenAICompatibleEmbeddingProvider,
  OpenAICompatibleProvider,
} from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';
import { MistralEmbeddingProvider, MistralProvider } from './mistral.js';
import { GeminiEmbeddingProvider, GeminiProvider } from './gemini.js';

export type LLMProviderId =
  | 'ollama'
  | 'openai-compatible'
  | 'anthropic'
  | 'mistral'
  | 'gemini';
export type EmbeddingProviderId =
  | 'ollama'
  | 'openai-compatible'
  | 'mistral'
  | 'gemini';

export interface LLMConfig {
  provider: LLMProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface EmbeddingConfig {
  provider: EmbeddingProviderId;
  model: string;
  dimension: number;
  baseUrl?: string;
  apiKey?: string;
}

export interface RegistryConfig {
  llm: LLMConfig;
  embedding: EmbeddingConfig;
}

export type LLMProviderFactory = (cfg: LLMConfig) => LLMProvider;
export type EmbeddingProviderFactory = (
  cfg: EmbeddingConfig
) => EmbeddingProvider;

const llmFactories = new Map<LLMProviderId, LLMProviderFactory>();
const embeddingFactories = new Map<EmbeddingProviderId, EmbeddingProviderFactory>();

export function registerLLMProvider(
  id: LLMProviderId,
  factory: LLMProviderFactory
): void {
  llmFactories.set(id, factory);
}

export function registerEmbeddingProvider(
  id: EmbeddingProviderId,
  factory: EmbeddingProviderFactory
): void {
  embeddingFactories.set(id, factory);
}

// Built-in registrations
registerLLMProvider('ollama', (cfg) =>
  new OllamaProvider({
    model: cfg.model,
    baseUrl: cfg.baseUrl,
  } satisfies OllamaProviderConfig)
);

registerEmbeddingProvider('ollama', (cfg) =>
  new OllamaEmbeddingProvider({
    model: cfg.model,
    dimension: cfg.dimension,
    baseUrl: cfg.baseUrl,
  } satisfies OllamaEmbeddingProviderConfig)
);

registerLLMProvider('openai-compatible', (cfg) => {
  if (!cfg.baseUrl) {
    throw new Error('openai-compatible provider requires llm.baseUrl');
  }
  return new OpenAICompatibleProvider({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
  });
});

registerEmbeddingProvider('openai-compatible', (cfg) => {
  if (!cfg.baseUrl) {
    throw new Error('openai-compatible embedding requires embedding.baseUrl');
  }
  return new OpenAICompatibleEmbeddingProvider({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    dimension: cfg.dimension,
    apiKey: cfg.apiKey,
  });
});

registerLLMProvider('anthropic', (cfg) => {
  if (!cfg.apiKey) {
    throw new Error('anthropic provider requires llm.apiKey');
  }
  return new AnthropicProvider({
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
  });
});

registerLLMProvider('mistral', (cfg) =>
  new MistralProvider({
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
  })
);

registerEmbeddingProvider('mistral', (cfg) =>
  new MistralEmbeddingProvider({
    model: cfg.model,
    dimension: cfg.dimension,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
  })
);

registerLLMProvider('gemini', (cfg) => {
  if (!cfg.apiKey) {
    throw new Error('gemini provider requires llm.apiKey');
  }
  return new GeminiProvider({
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
  });
});

registerEmbeddingProvider('gemini', (cfg) => {
  if (!cfg.apiKey) {
    throw new Error('gemini embedding requires embedding.apiKey');
  }
  return new GeminiEmbeddingProvider({
    apiKey: cfg.apiKey,
    model: cfg.model,
    dimension: cfg.dimension,
    baseUrl: cfg.baseUrl,
  });
});

export class ProviderRegistry {
  private llm: LLMProvider | null = null;
  private embedding: EmbeddingProvider | null = null;
  private readonly config: RegistryConfig;

  constructor(config: RegistryConfig) {
    this.config = config;
  }

  getLLM(): LLMProvider {
    if (!this.llm) {
      const f = llmFactories.get(this.config.llm.provider);
      if (!f) {
        throw new Error(
          `Unknown LLM provider: ${this.config.llm.provider}. Registered: ${[...llmFactories.keys()].join(', ')}`
        );
      }
      this.llm = f(this.config.llm);
    }
    return this.llm;
  }

  getEmbedding(): EmbeddingProvider {
    if (!this.embedding) {
      const f = embeddingFactories.get(this.config.embedding.provider);
      if (!f) {
        throw new Error(
          `Unknown embedding provider: ${this.config.embedding.provider}`
        );
      }
      this.embedding = f(this.config.embedding);
    }
    return this.embedding;
  }

  async healthCheckAll(): Promise<{
    llm: ProviderStatus;
    embedding: ProviderStatus;
  }> {
    const [llm, embedding] = await Promise.all([
      this.getLLM().healthCheck(),
      this.getEmbedding().healthCheck(),
    ]);
    return { llm, embedding };
  }

  async dispose(): Promise<void> {
    await Promise.all([
      this.llm?.dispose(),
      this.embedding?.dispose(),
    ]);
    this.llm = null;
    this.embedding = null;
  }
}
