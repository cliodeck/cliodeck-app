/**
 * Fusion step 1.2d tests: DocumentSummarizer drives abstractive summaries
 * and summary embeddings through the typed provider registry only.
 * The legacy `OllamaClient` slot was retired; tests assert that.
 */
import { describe, it, expect, vi } from 'vitest';
import { DocumentSummarizer } from '../DocumentSummarizer';
import type {
  EmbeddingProvider,
  LLMProvider,
} from '../../llm/providers/base';

function fakeLLM(canned: string): LLMProvider {
  return {
    id: 'fake',
    name: 'fake',
    capabilities: { chat: true, streaming: false, tools: false, embeddings: false },
    getStatus: () => ({ state: 'ready' }),
    healthCheck: async () => ({ state: 'ready' }),
    chat: async function* () {
      yield { delta: canned, done: true, finishReason: 'stop' as const };
    },
    complete: async () => canned,
    dispose: async () => undefined,
  };
}

function fakeEmbedding(vec: number[]): EmbeddingProvider {
  return {
    id: 'fake-e',
    name: 'fake-e',
    model: 'fake',
    dimension: vec.length,
    getStatus: () => ({ state: 'ready' }),
    healthCheck: async () => ({ state: 'ready' }),
    embed: async (texts) => texts.map(() => vec),
    dispose: async () => undefined,
  };
}

describe('DocumentSummarizer — registry path (1.2d)', () => {
  it('hasLLM is false when no provider is wired', () => {
    const s = new DocumentSummarizer({
      enabled: true,
      method: 'abstractive',
      maxLength: 200,
    });
    expect(s.hasLLM()).toBe(false);
  });

  it('abstractive path runs through providers.llm', async () => {
    const s = new DocumentSummarizer(
      { enabled: true, method: 'abstractive', maxLength: 200 },
      undefined,
      { llm: fakeLLM('VIA PROVIDER') }
    );
    const out = await s.generateSummary('Some long document text.');
    expect(out).toBe('VIA PROVIDER');
  });

  it('falls back to extractive when no LLM is configured', async () => {
    const s = new DocumentSummarizer({
      enabled: true,
      method: 'abstractive',
      maxLength: 100,
    });
    // Without a typed LLM, `generateSummary` should warn and use extractive
    // — output is non-empty rather than throwing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = await s.generateSummary(
      'Recherche méthodologique. Les résultats montrent que. Une conclusion importante.'
    );
    expect(typeof out).toBe('string');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('embedding path prefers embeddingFunction over embeddingProvider', async () => {
    const custom = vi.fn(async () => new Float32Array([1, 2]));
    const s = new DocumentSummarizer(
      { enabled: true, method: 'extractive', maxLength: 100 },
      custom,
      { embedding: fakeEmbedding([9, 9, 9]) }
    );
    const out = await s.generateSummaryEmbedding('summary');
    expect(Array.from(out)).toEqual([1, 2]);
    expect(custom).toHaveBeenCalled();
  });

  it('embeddingProvider is used when no custom function is set', async () => {
    const s = new DocumentSummarizer(
      { enabled: true, method: 'extractive', maxLength: 100 },
      undefined,
      { embedding: fakeEmbedding([7, 8, 9]) }
    );
    const out = await s.generateSummaryEmbedding('summary');
    expect(Array.from(out)).toEqual([7, 8, 9]);
  });

  it('throws a clear error when no embedding path is configured', async () => {
    const s = new DocumentSummarizer({
      enabled: true,
      method: 'extractive',
      maxLength: 100,
    });
    await expect(s.generateSummaryEmbedding('x')).rejects.toThrow(
      /no embedding path configured/i
    );
  });

  it('setProviders lets callers wire providers after construction', async () => {
    const s = new DocumentSummarizer({
      enabled: true,
      method: 'abstractive',
      maxLength: 100,
    });
    expect(s.hasLLM()).toBe(false);
    s.setProviders({ llm: fakeLLM('LATE') });
    expect(s.hasLLM()).toBe(true);
    const out = await s.generateSummary('text');
    expect(out).toBe('LATE');
  });
});
