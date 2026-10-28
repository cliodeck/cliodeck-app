/**
 * Truth table for the toggles → (sourceType, includeVault, includeManuscript)
 * resolver in ragQueryStore.getResolvedSourceType(), plus the tri-state
 * manuscript toggle (`resolveManuscriptToggle`) and the display-order helper
 * (`effectiveSourceFamilies`).
 *
 * Covers the 8 combinations of the three source toggles, each with the
 * manuscript effective or not. The empty case falls back to a permissive
 * "search everything" plus an `isEmpty` warning flag — except when the
 * manuscript alone is effective: that is a valid manuscript-only scope and
 * is never widened (docs/poids-du-manuscrit.md, palier 2 — « qu'ai-je déjà
 * écrit ? » must never land on the sources).
 */
import { describe, it, expect } from 'vitest';
import {
  getResolvedSourceType,
  resolveManuscriptToggle,
  effectiveSourceFamilies,
  type RAGQueryParams,
} from '../ragQueryStore';

function make(b: boolean, p: boolean, n: boolean, includeManuscript?: boolean): RAGQueryParams {
  return {
    provider: 'auto',
    model: 'gemma2:2b',
    topK: 10,
    timeout: 600000,
    numCtx: 4096,
    includeBibliography: b,
    includePrimary: p,
    includeNotes: n,
    includeManuscript,
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

/** The seven non-empty source combinations and their (sourceType, includeVault). */
const SEVEN_CASES: Array<{
  label: string;
  toggles: [boolean, boolean, boolean];
  sourceType: 'primary' | 'secondary' | 'both' | 'vault';
  includeVault: boolean;
}> = [
  { label: 'all three on', toggles: [true, true, true], sourceType: 'both', includeVault: true },
  { label: 'biblio + primary', toggles: [true, true, false], sourceType: 'both', includeVault: false },
  { label: 'biblio + notes', toggles: [true, false, true], sourceType: 'secondary', includeVault: true },
  { label: 'primary + notes', toggles: [false, true, true], sourceType: 'primary', includeVault: true },
  { label: 'biblio only', toggles: [true, false, false], sourceType: 'secondary', includeVault: false },
  { label: 'primary only', toggles: [false, true, false], sourceType: 'primary', includeVault: false },
  { label: 'notes only', toggles: [false, false, true], sourceType: 'vault', includeVault: true },
];

describe('getResolvedSourceType — seven source cases, manuscript effective', () => {
  it.each(SEVEN_CASES)('$label → $sourceType, vault=$includeVault, manuscript on', (c) => {
    expect(getResolvedSourceType(make(...c.toggles), true)).toEqual({
      sourceType: c.sourceType,
      includeVault: c.includeVault,
      includeManuscript: true,
      isEmpty: false,
    });
  });
});

describe('getResolvedSourceType — seven source cases, manuscript off', () => {
  it.each(SEVEN_CASES)('$label → $sourceType, vault=$includeVault, manuscript off', (c) => {
    expect(getResolvedSourceType(make(...c.toggles), false)).toEqual({
      sourceType: c.sourceType,
      includeVault: c.includeVault,
      includeManuscript: false,
      isEmpty: false,
    });
  });
});

describe('getResolvedSourceType — nothing among the three source toggles', () => {
  it('manuscript effective → manuscript-only, a valid scope, never widened', () => {
    expect(getResolvedSourceType(make(false, false, false), true)).toEqual({
      sourceType: 'manuscript',
      includeVault: false,
      includeManuscript: true,
      isEmpty: false,
    });
  });

  it('manuscript off → permissive fallback flagged isEmpty, manuscript stays off', () => {
    const resolved = getResolvedSourceType(make(false, false, false), false);
    expect(resolved.isEmpty).toBe(true);
    // Permissive fallback so a turn is never silently killed.
    expect(resolved.sourceType).toBe('both');
    expect(resolved.includeVault).toBe(true);
    // The fallback widens the SOURCES only: the manuscript is not smuggled in.
    expect(resolved.includeManuscript).toBe(false);
  });

  it('ignores the raw tri-state on params: only the effective value counts', () => {
    // Pinned `true` on params but resolved `false` by the caller (should not
    // happen, but the resolver must trust its second argument alone).
    expect(getResolvedSourceType(make(false, false, false, true), false).isEmpty).toBe(true);
    expect(getResolvedSourceType(make(false, false, false, false), true).sourceType).toBe('manuscript');
  });
});

describe('resolveManuscriptToggle — tri-state against the workspace', () => {
  it('undefined follows the workspace: off in Brainstorm, on everywhere else', () => {
    expect(resolveManuscriptToggle(undefined, 'brainstorm')).toBe(false);
    for (const workspace of ['explore', 'write', 'export'] as const) {
      expect(resolveManuscriptToggle(undefined, workspace)).toBe(true);
    }
  });

  it('a pinned value wins over the workspace default, both ways', () => {
    expect(resolveManuscriptToggle(true, 'brainstorm')).toBe(true);
    expect(resolveManuscriptToggle(false, 'write')).toBe(false);
    expect(resolveManuscriptToggle(false, 'explore')).toBe(false);
    expect(resolveManuscriptToggle(true, 'export')).toBe(true);
  });
});

describe('effectiveSourceFamilies — display order shared by panel and scope line', () => {
  it('lists the ticked families in order, manuscript last', () => {
    expect(effectiveSourceFamilies(make(true, true, true), true)).toEqual([
      'bibliography',
      'primary',
      'notes',
      'manuscript',
    ]);
    expect(effectiveSourceFamilies(make(false, true, false), true)).toEqual(['primary', 'manuscript']);
    expect(effectiveSourceFamilies(make(true, false, true), false)).toEqual(['bibliography', 'notes']);
  });

  it('manuscript alone → [manuscript] ; nothing effective → []', () => {
    expect(effectiveSourceFamilies(make(false, false, false), true)).toEqual(['manuscript']);
    expect(effectiveSourceFamilies(make(false, false, false), false)).toEqual([]);
  });
});
