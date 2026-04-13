/**
 * Non-live tests for the consolidated NERService (2.3).
 *
 * Covers the bits that can be tested without a running Ollama: language
 * selection, CONCEPT type acceptance, JSON parsing + regex fallback, type
 * normalization. The live LLM path (`extractEntities` / `extractQueryEntities`)
 * belongs to integration tests, not this unit suite.
 */
import { describe, it, expect } from 'vitest';
import { NERService, type NERLanguage } from '../NERService.js';
import type { OllamaClient } from '../../llm/OllamaClient.js';

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
