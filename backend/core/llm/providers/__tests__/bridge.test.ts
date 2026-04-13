import { describe, it, expect } from 'vitest';
import {
  createRegistryFromLegacyConfig,
  legacyConfigToRegistryConfig,
} from '../bridge.js';
import type { LLMProviderConfig } from '../../LLMProviderManager.js';

describe('legacy-config bridge (1.4a)', () => {
  const base: LLMProviderConfig = {
    provider: 'ollama',
    ollamaURL: 'http://10.0.0.5:11434',
    ollamaChatModel: 'mistral:7b',
    ollamaEmbeddingModel: 'mxbai-embed-large',
  };

  it('translates the canonical fields', () => {
    const r = legacyConfigToRegistryConfig(base);
    expect(r.llm.provider).toBe('ollama');
    expect(r.llm.model).toBe('mistral:7b');
    expect(r.llm.baseUrl).toBe('http://10.0.0.5:11434');
    expect(r.embedding.model).toBe('mxbai-embed-large');
    expect(r.embedding.baseUrl).toBe('http://10.0.0.5:11434');
    expect(r.embedding.dimension).toBe(1024);
  });

  it('resolves dimension for known models including suffixed tags', () => {
    const r = legacyConfigToRegistryConfig({
      ...base,
      ollamaEmbeddingModel: 'nomic-embed-text:latest',
    });
    expect(r.embedding.dimension).toBe(768);
  });

  it('falls back to 768 for unknown models without override', () => {
    const r = legacyConfigToRegistryConfig({
      ...base,
      ollamaEmbeddingModel: 'custom-weird-model',
    });
    expect(r.embedding.dimension).toBe(768);
  });

  it('honors dimensionOverride', () => {
    const r = legacyConfigToRegistryConfig(
      { ...base, ollamaEmbeddingModel: 'custom' },
      { dimensionOverride: 512 }
    );
    expect(r.embedding.dimension).toBe(512);
  });

  it('defaults baseUrl when legacy config omits it', () => {
    const r = legacyConfigToRegistryConfig({ provider: 'ollama' });
    expect(r.llm.baseUrl).toBe('http://127.0.0.1:11434');
    expect(r.llm.model).toBe('llama3.2');
    expect(r.embedding.model).toBe('nomic-embed-text');
  });

  it('factory returns a wired ProviderRegistry', () => {
    const reg = createRegistryFromLegacyConfig(base);
    const p = reg.getLLM();
    expect(p.id).toBe('ollama');
    const e = reg.getEmbedding();
    expect(e.id).toBe('ollama-embedding');
    expect(e.dimension).toBe(1024);
  });
});
