/**
 * Truth table for the three-toggle → (sourceType, includeVault) resolver
 * in ragQueryStore.getResolvedSourceType().
 *
 * Covers all 8 combinations; the empty case falls back to a permissive
 * "search everything" plus an `isEmpty` warning flag.
 */
import { describe, it, expect } from 'vitest';
import { getResolvedSourceType, type RAGQueryParams } from '../ragQueryStore';

function make(b: boolean, p: boolean, n: boolean): RAGQueryParams {
  return {
    provider: 'auto',
    model: 'gemma2:2b',
    topK: 10,
    timeout: 600000,
    numCtx: 4096,
    includeBibliography: b,
    includePrimary: p,
    includeNotes: n,
    selectedCollectionKeys: [],
    selectedDocumentIds: [],
    temperature: 0.1,
    top_p: 0.85,
    top_k: 40,
    repeat_penalty: 1.1,
    systemPromptLanguage: 'fr',
    useCustomSystemPrompt: false,
  };
}

describe('getResolvedSourceType — truth table', () => {
  it('all three on → both + vault', () => {
    expect(getResolvedSourceType(make(true, true, true))).toEqual({
      sourceType: 'both',
      includeVault: true,
      isEmpty: false,
    });
  });

  it('biblio + primary → both, no vault', () => {
    expect(getResolvedSourceType(make(true, true, false))).toEqual({
      sourceType: 'both',
      includeVault: false,
      isEmpty: false,
    });
  });

  it('biblio + notes → secondary + vault', () => {
    expect(getResolvedSourceType(make(true, false, true))).toEqual({
      sourceType: 'secondary',
      includeVault: true,
      isEmpty: false,
    });
  });

  it('primary + notes → primary + vault', () => {
    expect(getResolvedSourceType(make(false, true, true))).toEqual({
      sourceType: 'primary',
      includeVault: true,
      isEmpty: false,
    });
  });

  it('biblio only → secondary, no vault', () => {
    expect(getResolvedSourceType(make(true, false, false))).toEqual({
      sourceType: 'secondary',
      includeVault: false,
      isEmpty: false,
    });
  });

  it('primary only → primary, no vault', () => {
    expect(getResolvedSourceType(make(false, true, false))).toEqual({
      sourceType: 'primary',
      includeVault: false,
      isEmpty: false,
    });
  });

  it('notes only → vault (implicit includeVault)', () => {
    expect(getResolvedSourceType(make(false, false, true))).toEqual({
      sourceType: 'vault',
      includeVault: true,
      isEmpty: false,
    });
  });

  it('none → permissive fallback flagged isEmpty', () => {
    const resolved = getResolvedSourceType(make(false, false, false));
    expect(resolved.isEmpty).toBe(true);
    // Permissive fallback so a turn is never silently killed.
    expect(resolved.sourceType).toBe('both');
    expect(resolved.includeVault).toBe(true);
  });
});
