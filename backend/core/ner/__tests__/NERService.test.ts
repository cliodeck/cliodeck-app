/**
 * Non-live tests for the consolidated NERService (2.3).
 *
 * Covers the bits that can be tested without a running Ollama: language
 * selection, CONCEPT type acceptance, JSON parsing + regex fallback, type
 * normalization. The live LLM path (`extractEntities` / `extractQueryEntities`)
 * belongs to integration tests, not this unit suite.
 */
import { describe, it, expect, vi } from 'vitest';
import { NERService, type NERLanguage } from '../NERService.js';
import type { OllamaClient } from '../../llm/OllamaClient.js';
import type { LLMProvider } from '../../llm/providers/base.js';

function makeService(language: NERLanguage = 'fr'): NERService {
  const stub = {} as unknown as OllamaClient;
  return new NERService(stub, undefined, language);
}

describe('NERService consolidated (2.3)', () => {
  it('defaults to French and accepts setLanguage', () => {
    const s = makeService();
    s.setLanguage('de');
    // no public getter; just assert no throw + language-dependent behavior
    // via the parser — which is language-agnostic. This is a smoke test for
    // setLanguage being a real method and CONCEPT being in the public type.
    expect(typeof s.setLanguage).toBe('function');
  });

  it.each<NERLanguage>(['fr', 'en', 'de'])(
    'can be constructed with language %s',
    (lang) => {
      const s = new NERService(
        {} as unknown as OllamaClient,
        undefined,
        lang
      );
      expect(s).toBeInstanceOf(NERService);
    }
  );

  // Parser / fallback tests via (private) methods exposed through a test
  // subclass — keeps the public API clean.
  class Exposed extends NERService {
    public parse(r: string) {
      return (this as unknown as {
        parseEntitiesFromResponse(r: string): unknown;
      }).parseEntitiesFromResponse(r);
    }
    public fallback(r: string) {
      return (this as unknown as { fallbackParse(r: string): unknown }).fallbackParse(r);
    }
    public normalize(t: string) {
      return (this as unknown as { normalizeType(t: string): string }).normalizeType(t);
    }
  }

  it('parses CONCEPT entities from JSON array', () => {
    const s = new Exposed({} as unknown as OllamaClient);
    const out = s.parse(
      '[{"name":"longue durée","type":"CONCEPT","context":"… la longue durée …"}]'
    ) as Array<{ name: string; type: string }>;
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('CONCEPT');
  });

  it('accepts mixed 5+1 entity types including CONCEPT', () => {
    const s = new Exposed({} as unknown as OllamaClient);
    const out = s.parse(
      JSON.stringify([
        { name: 'de Gaulle', type: 'PERSON', context: '' },
        { name: 'Paris', type: 'LOCATION', context: '' },
        { name: '1940', type: 'DATE', context: '' },
        { name: 'SNCF', type: 'ORGANIZATION', context: '' },
        { name: 'Appel du 18 juin', type: 'EVENT', context: '' },
        { name: 'mémoire collective', type: 'CONCEPT', context: '' },
      ])
    ) as Array<{ type: string }>;
    expect(out.map((e) => e.type).sort()).toEqual([
      'CONCEPT',
      'DATE',
      'EVENT',
      'LOCATION',
      'ORGANIZATION',
      'PERSON',
    ]);
  });

  it('normalizeType accepts CONCEPT (lowercase too)', () => {
    const s = new Exposed({} as unknown as OllamaClient);
    expect(s.normalize('concept')).toBe('CONCEPT');
    expect(s.normalize('CONCEPT')).toBe('CONCEPT');
  });

  it('regex fallback still parses malformed JSON', () => {
    const s = new Exposed({} as unknown as OllamaClient);
    const malformed = `... some noise {"name":"Verdun", "type":"LOCATION", but broken`;
    const out = s.fallback(malformed) as Array<{ name: string; type: string }>;
    expect(out).toEqual([{ name: 'Verdun', type: 'LOCATION', context: '' }]);
  });
});

describe('NERService — registry path (1.4c)', () => {
  function fakeLLM(canned: string, mockComplete?: ReturnType<typeof vi.fn>): LLMProvider {
    const complete = mockComplete ?? vi.fn(async () => canned);
    return {
      id: 'fake',
      name: 'fake',
      capabilities: { chat: true, streaming: false, tools: false, embeddings: false },
      getStatus: () => ({ state: 'ready' }),
      healthCheck: async () => ({ state: 'ready' }),
      chat: async function* () {
        yield { delta: canned, done: true, finishReason: 'stop' as const };
      },
      complete,
      dispose: async () => undefined,
    } as LLMProvider;
  }

  it('routes extractEntities through providers.llm when configured', async () => {
    const cannedJson = '[{"name":"de Gaulle","type":"PERSON","context":"ctx"}]';
    const complete = vi.fn(async () => cannedJson);
    const stubOllama = {
      chatModel: 'mistral',
      generateResponseStream: async function* () {
        throw new Error('OllamaClient should NOT be called when providers.llm is set');
      },
    } as unknown as OllamaClient;
    const ner = new NERService(stubOllama, undefined, 'fr', {
      llm: fakeLLM(cannedJson, complete),
    });
    const result = await ner.extractEntities('Un texte historique un peu long.');
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('de Gaulle');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('routes extractQueryEntities through providers.llm', async () => {
    const cannedJson = '[{"name":"Paris","type":"LOCATION"}]';
    const complete = vi.fn(async () => cannedJson);
    const stubOllama = {
      chatModel: 'mistral',
      generateResponseStream: async function* () {
        throw new Error('should not be called');
      },
    } as unknown as OllamaClient;
    const ner = new NERService(stubOllama, undefined, 'fr', {
      llm: fakeLLM(cannedJson, complete),
    });
    const out = await ner.extractQueryEntities('Où est Paris ?');
    expect(out).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('setProviders lets callers wire llm after construction', async () => {
    const cannedJson = '[{"name":"Vichy","type":"LOCATION"}]';
    let callCount = 0;
    const stubOllama = {
      chatModel: 'mistral',
      generateResponseStream: async function* () {
        callCount += 1;
        yield cannedJson;
      },
    } as unknown as OllamaClient;

    const ner = new NERService(stubOllama);
    // First call — no provider, goes through Ollama.
    await ner.extractEntities('Un long texte à analyser en détail.');
    expect(callCount).toBe(1);

    // Swap in provider; next call bypasses Ollama.
    const complete = vi.fn(async () => cannedJson);
    ner.setProviders({ llm: fakeLLM(cannedJson, complete) });
    await ner.extractEntities('Un autre texte encore plus long à examiner.');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(callCount).toBe(1); // unchanged — ollama no longer used
  });
});
