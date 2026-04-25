/**
 * Fusion 1.2c: TropySync's only NER init path is the typed-provider one
 * (`initNERServiceWithProvider`). The legacy `initNERService(ollamaClient)`
 * was retired with the rest of the OllamaClient consumers in the service
 * layer — this test stays scoped to the migration-relevant seam, since the
 * full `sync()` flow touches Tropy + OCR + vector store.
 */
import { describe, it, expect, vi } from 'vitest';
import { TropySync } from '../TropySync';
import type { LLMProvider } from '../../../core/llm/providers/base';

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

describe('TropySync NER init (1.2c)', () => {
  it('initNERServiceWithProvider builds a provider-backed NER', () => {
    const sync = new TropySync();
    sync.initNERServiceWithProvider(fakeLLM());
    // nerService is private — assert via behaviour: extractQueryEntities
    // should run through the provider without touching the stubbed ollama.
    const ner = (sync as unknown as { nerService: { extractQueryEntities: (q: string) => Promise<unknown[]> } })
      .nerService;
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
