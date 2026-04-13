/**
 * Legacy-config bridge (fusion step 1.4a).
 *
 * Full migration of the 16+ call sites that use `OllamaClient` /
 * `LLMProviderManager` directly (step 1.4 as-written) is an intrusive change
 * that invalidates the existing RAG-specific surface (error classification,
 * chunked embeddings, dynamic num_ctx). Rather than boil the ocean in a
 * single PR, this bridge translates the *existing* workspace config
 * (`LLMProviderConfig` from LLMProviderManager) into a `ProviderRegistry`,
 * so new features (recipes, brainstorm, MCP tools) can start on the typed
 * provider layer immediately, while legacy call sites keep their current
 * pipeline untouched until each is migrated on its own PR.
 *
 * Scope:
 * - Reads the canonical Ollama fields from the legacy config.
 * - Skips the 'embedded' GGUF path (no provider impl yet; add when the
 *   embedded llama.cpp wrapper gains a thin LLMProvider adapter).
 * - Embedding dimension defaults come from known Ollama embedding models;
 *   override via `dimensionOverride` when using a custom model.
 */

import type { LLMProviderConfig } from '../LLMProviderManager.js';
import { ProviderRegistry, type RegistryConfig } from './registry.js';

/**
 * Known embedding dimensions for the Ollama models the app currently supports.
 * Extend this when adding a new default; callers can always override.
 */
const OLLAMA_EMBEDDING_DIMS: Record<string, number> = {
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
  'snowflake-arctic-embed': 1024,
};

export interface BridgeOptions {
  /** Override the embedding dimension when the legacy config names a non-standard model. */
  dimensionOverride?: number;
  /** Default chat model to use when the legacy config omits `ollamaChatModel`. */
  defaultChatModel?: string;
  /** Default embedding model when the legacy config omits `ollamaEmbeddingModel`. */
  defaultEmbeddingModel?: string;
}

export function legacyConfigToRegistryConfig(
  legacy: LLMProviderConfig,
  opts: BridgeOptions = {}
): RegistryConfig {
  const ollamaUrl = legacy.ollamaURL ?? 'http://127.0.0.1:11434';
  const chatModel =
    legacy.ollamaChatModel ?? opts.defaultChatModel ?? 'llama3.2';
  const embeddingModel =
    legacy.ollamaEmbeddingModel ??
    opts.defaultEmbeddingModel ??
    'nomic-embed-text';

  const dimension =
    opts.dimensionOverride ??
    OLLAMA_EMBEDDING_DIMS[embeddingModel.split(':')[0]] ??
    768;

  return {
    llm: {
      provider: 'ollama',
      model: chatModel,
      baseUrl: ollamaUrl,
    },
    embedding: {
      provider: 'ollama',
      model: embeddingModel,
      dimension,
      baseUrl: ollamaUrl,
    },
  };
}

export function createRegistryFromLegacyConfig(
  legacy: LLMProviderConfig,
  opts: BridgeOptions = {}
): ProviderRegistry {
  return new ProviderRegistry(legacyConfigToRegistryConfig(legacy, opts));
}
