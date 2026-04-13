import { describe, it, expect } from 'vitest';
import {
  ProviderRegistry,
  registerLLMProvider,
  type RegistryConfig,
} from '../registry.js';
import type { LLMProvider, ProviderStatus } from '../base.js';

function fakeLLM(id: string): LLMProvider {
  const status: ProviderStatus = { state: 'ready', lastReadyAt: 'now' };
  return {
    id,
    name: id,
    capabilities: { chat: true, streaming: false, tools: false, embeddings: false },
    getStatus: () => status,
    healthCheck: async () => status,
    chat: async function* () {
      yield { delta: 'ok', done: true, finishReason: 'stop' as const };
    },
    complete: async () => 'ok',
    dispose: async () => undefined,
  };
}

describe('ProviderRegistry', () => {
  const baseConfig: RegistryConfig = {
    llm: { provider: 'ollama', model: 'llama3.2' },
    embedding: { provider: 'ollama', model: 'nomic-embed-text', dimension: 768 },
  };

  it('resolves built-in ollama LLM provider', () => {
    const r = new ProviderRegistry(baseConfig);
    const p = r.getLLM();
    expect(p.id).toBe('ollama');
  });

  it('caches provider instance across calls', () => {
    const r = new ProviderRegistry(baseConfig);
    expect(r.getLLM()).toBe(r.getLLM());
  });

  it('throws on unknown provider id', () => {
    const r = new ProviderRegistry({
      ...baseConfig,
      llm: { provider: 'does-not-exist' as never, model: 'x' },
    });
    expect(() => r.getLLM()).toThrow(/Unknown LLM provider/);
  });

  it('allows registering a new provider from tests', () => {
    registerLLMProvider('openai-compatible', () => fakeLLM('openai-compatible'));
    const r = new ProviderRegistry({
      ...baseConfig,
      llm: { provider: 'openai-compatible', model: 'gpt-4o' },
    });
    expect(r.getLLM().id).toBe('openai-compatible');
  });

  it('dispose clears cached instances', async () => {
    const r = new ProviderRegistry(baseConfig);
    const a = r.getLLM();
    await r.dispose();
    const b = r.getLLM();
    expect(a).not.toBe(b);
  });
});
