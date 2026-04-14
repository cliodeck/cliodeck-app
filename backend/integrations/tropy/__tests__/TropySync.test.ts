/**
 * Fusion 1.4d: TropySync can be wired to the typed provider registry for
 * NER without going through OllamaClient. The full `sync()` flow touches
 * Tropy + OCR + vector store and isn't reasonable to mock out here; we
 * cover the migration-relevant seam (NER init path selection) directly.
 */
import { describe, it, expect, vi } from 'vitest';
import { TropySync } from '../TropySync';
import type { LLMProvider } from '../../../core/llm/providers/base';
import type { OllamaClient } from '../../../core/llm/OllamaClient';

function fakeLLM(): LLMProvider {
  return {
    id: 'fake',
    name: 'fake',
    capabilities: { chat: true, streaming: false, tools: false, embeddings: false },
    getStatus: () => ({ state: 'ready' }),
    healthCheck: async () => ({ state: 'ready' }),
    chat: async function* () {
      yield { delta: '[]', done: true, finishReason: 'stop' as const };
    },
    complete: async () => '[]',
    dispose: async () => undefined,
  };
}

function fakeOllama(): OllamaClient {
  return {
    chatModel: 'llama',
    generateResponseStream: async function* () {
      yield '[]';
    },
  } as unknown as OllamaClient;
}

describe('TropySync NER init (1.4d)', () => {
  it('initNERServiceWithProvider builds a provider-backed NER', () => {
    const sync = new TropySync();
    sync.initNERServiceWithProvider(fakeLLM());
    // nerService is private — assert via behaviour: extractQueryEntities
    // should run through the provider without touching the stubbed ollama.
    const ner = (sync as unknown as { nerService: { extractQueryEntities: (q: string) => Promise<unknown[]> } })
      .nerService;
    expect(ner).toBeTruthy();
  });

  it('initNERService (legacy) still wires through OllamaClient', () => {
    const sync = new TropySync();
    sync.initNERService(fakeOllama());
    const ner = (sync as unknown as { nerService: unknown }).nerService;
    expect(ner).toBeTruthy();
  });

  it('provider path does NOT invoke OllamaClient.generateResponseStream', async () => {
    const llm = fakeLLM();
    const completeSpy = vi.spyOn(llm, 'complete');
    const sync = new TropySync();
    sync.initNERServiceWithProvider(llm);
    const ner = (sync as unknown as { nerService: { extractQueryEntities: (q: string) => Promise<unknown[]> } })
      .nerService;
    await ner.extractQueryEntities('Paris en 1940 ?');
    expect(completeSpy).toHaveBeenCalledTimes(1);
  });
});
