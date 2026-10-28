/**
 * Truth table for the toggles → (sourceType, includeVault, includeManuscript,
 * includeReadingNotes) resolver in ragQueryStore.getResolvedSourceType(),
 * plus the tri-state toggles of the two corpora in the author's own voice
 * (`resolveManuscriptToggle`, `resolveReadingNotesToggle`), the display-order
 * helper (`effectiveSourceFamilies`) and the two exclusion predictors.
 *
 * Covers the 8 combinations of the three source toggles, each with the
 * manuscript and the reading notes effective or not. The empty case falls
 * back to a permissive "search everything" plus an `isEmpty` warning flag —
 * except when the manuscript or the reading notes alone are effective: those
 * are valid own-text scopes and are never widened
 * (docs/poids-du-manuscrit.md, palier 2 — « qu'ai-je déjà écrit ? » and
 * « qu'ai-je noté sur… ? » must never land on the sources).
 */
import { describe, it, expect } from 'vitest';
import {
  getResolvedSourceType,
  resolveManuscriptToggle,
  resolveReadingNotesToggle,
  resolveOwnTextToggle,
  effectiveSourceFamilies,
  type RAGQueryParams,
  manuscriptExclusionReason,
  readingNotesExclusionReason,
  readingNotesStance,
} from '../ragQueryStore';

function make(
  b: boolean,
  p: boolean,
  n: boolean,
  includeManuscript?: boolean,
  includeReadingNotes?: boolean
): RAGQueryParams {
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
    includeReadingNotes,
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

/** The four combinations of the two own-text toggles. */
const OWN_TEXT_COMBOS: Array<{ label: string; m: boolean; r: boolean }> = [
  { label: 'manuscript on, reading notes on', m: true, r: true },
  { label: 'manuscript on, reading notes off', m: true, r: false },
  { label: 'manuscript off, reading notes on', m: false, r: true },
  { label: 'manuscript off, reading notes off', m: false, r: false },
];

describe('getResolvedSourceType — seven source cases × own-text toggles', () => {
  for (const combo of OWN_TEXT_COMBOS) {
    it.each(SEVEN_CASES)(`$label → $sourceType, vault=$includeVault, ${combo.label}`, (c) => {
      expect(getResolvedSourceType(make(...c.toggles), combo.m, combo.r)).toEqual({
        sourceType: c.sourceType,
        includeVault: c.includeVault,
        includeManuscript: combo.m,
        includeReadingNotes: combo.r,
        isEmpty: false,
      });
    });
  }
});

describe('getResolvedSourceType — nothing among the three source toggles', () => {
  it('manuscript effective → manuscript-only, a valid scope, never widened; the notes ride along', () => {
    expect(getResolvedSourceType(make(false, false, false), true, false)).toEqual({
      sourceType: 'manuscript',
      includeVault: false,
      includeManuscript: true,
      includeReadingNotes: false,
      isEmpty: false,
    });
    // Manuscript + notes, no sources: main accepts the pair under
    // `sourceType: 'manuscript'`.
    expect(getResolvedSourceType(make(false, false, false), true, true)).toEqual({
      sourceType: 'manuscript',
      includeVault: false,
      includeManuscript: true,
      includeReadingNotes: true,
      isEmpty: false,
    });
  });

  it('reading notes alone effective → notes-only, a valid scope, never widened', () => {
    expect(getResolvedSourceType(make(false, false, false), false, true)).toEqual({
      sourceType: 'readingNotes',
      includeVault: false,
      includeManuscript: false,
      includeReadingNotes: true,
      isEmpty: false,
    });
  });

  it('both off → permissive fallback flagged isEmpty, neither own-text corpus smuggled in', () => {
    const resolved = getResolvedSourceType(make(false, false, false), false, false);
    expect(resolved.isEmpty).toBe(true);
    // Permissive fallback so a turn is never silently killed.
    expect(resolved.sourceType).toBe('both');
    expect(resolved.includeVault).toBe(true);
    // The fallback widens the SOURCES only.
    expect(resolved.includeManuscript).toBe(false);
    expect(resolved.includeReadingNotes).toBe(false);
  });

  it('ignores the raw tri-states on params: only the effective values count', () => {
    // Pinned `true` on params but resolved `false` by the caller (should not
    // happen, but the resolver must trust its arguments alone).
    expect(getResolvedSourceType(make(false, false, false, true, true), false, false).isEmpty).toBe(true);
    expect(getResolvedSourceType(make(false, false, false, false, false), true, false).sourceType).toBe('manuscript');
    expect(getResolvedSourceType(make(false, false, false, false, false), false, true).sourceType).toBe('readingNotes');
  });
});

describe('resolveManuscriptToggle / resolveReadingNotesToggle — tri-state against the workspace', () => {
  const RESOLVERS: Array<[string, typeof resolveOwnTextToggle]> = [
    ['own text', resolveOwnTextToggle],
    ['manuscript', resolveManuscriptToggle],
    ['reading notes', resolveReadingNotesToggle],
  ];

  it.each(RESOLVERS)('%s: undefined follows the workspace — off in Brainstorm, on everywhere else', (_label, resolve) => {
    expect(resolve(undefined, 'brainstorm')).toBe(false);
    for (const workspace of ['explore', 'write', 'export'] as const) {
      expect(resolve(undefined, workspace)).toBe(true);
    }
  });

  it.each(RESOLVERS)('%s: a pinned value wins over the workspace default, both ways', (_label, resolve) => {
    expect(resolve(true, 'brainstorm')).toBe(true);
    expect(resolve(false, 'write')).toBe(false);
    expect(resolve(false, 'explore')).toBe(false);
    expect(resolve(true, 'export')).toBe(true);
  });
});

describe('effectiveSourceFamilies — display order shared by panel and scope line', () => {
  it('lists the ticked families in the panel order: the three sources, manuscript, reading notes', () => {
    expect(effectiveSourceFamilies(make(true, true, true), true, true)).toEqual([
      'bibliography',
      'primary',
      'notes',
      'manuscript',
      'readingNotes',
    ]);
    expect(effectiveSourceFamilies(make(false, true, false), true, false)).toEqual(['primary', 'manuscript']);
    expect(effectiveSourceFamilies(make(true, false, true), false, true)).toEqual([
      'bibliography',
      'notes',
      'readingNotes',
    ]);
    expect(effectiveSourceFamilies(make(true, false, true), false, false)).toEqual(['bibliography', 'notes']);
  });

  it('manuscript alone → [manuscript] ; notes alone → [readingNotes] ; nothing effective → []', () => {
    expect(effectiveSourceFamilies(make(false, false, false), true, false)).toEqual(['manuscript']);
    expect(effectiveSourceFamilies(make(false, false, false), false, true)).toEqual(['readingNotes']);
    expect(effectiveSourceFamilies(make(false, false, false), true, true)).toEqual(['manuscript', 'readingNotes']);
    expect(effectiveSourceFamilies(make(false, false, false), false, false)).toEqual([]);
  });
});

describe('manuscriptExclusionReason — la ligne de portée ne promet pas un manuscrit que le main écarte', () => {
  const base = {
    includeBibliography: true,
    includePrimary: true,
    includeNotes: true,
    selectedDocumentIds: [] as string[],
    selectedCollectionKeys: [] as string[],
  } as unknown as Parameters<typeof manuscriptExclusionReason>[0]['params'];
  const open = (over: Partial<typeof base> = {}) => ({ ...base, ...over });

  it('consulté dans une recherche ouverte, case effective', () => {
    expect(
      manuscriptExclusionReason({ params: open(), manuscriptEffective: true, indexEnabled: true })
    ).toBeNull();
  });

  it('écarté sans index, quoi que dise la case', () => {
    expect(
      manuscriptExclusionReason({ params: open(), manuscriptEffective: true, indexEnabled: false })
    ).toBe('disabled');
  });

  it('écarté par une recherche restreinte : notes seules, documents choisis, collection', () => {
    expect(
      manuscriptExclusionReason({
        params: open({ includeBibliography: false, includePrimary: false }),
        manuscriptEffective: true,
        indexEnabled: true,
      })
    ).toBe('scope');
    expect(
      manuscriptExclusionReason({
        params: open({ selectedDocumentIds: ['d1'] }),
        manuscriptEffective: true,
        indexEnabled: true,
      })
    ).toBe('scope');
    expect(
      manuscriptExclusionReason({
        params: open({ selectedCollectionKeys: ['K'] }),
        manuscriptEffective: true,
        indexEnabled: true,
      })
    ).toBe('scope');
  });

  it('manuscrit seul : consulté, c’est la portée demandée', () => {
    expect(
      manuscriptExclusionReason({
        params: open({ includeBibliography: false, includePrimary: false, includeNotes: false }),
        manuscriptEffective: true,
        indexEnabled: true,
      })
    ).toBeNull();
  });

  it('écarté par la case, puis par la posture « off » du mode', () => {
    expect(
      manuscriptExclusionReason({ params: open(), manuscriptEffective: false, indexEnabled: true })
    ).toBe('toggle');
    expect(
      manuscriptExclusionReason({
        params: open(),
        manuscriptEffective: true,
        stance: 'off',
        indexEnabled: true,
      })
    ).toBe('stance');
    expect(
      manuscriptExclusionReason({
        params: open(),
        manuscriptEffective: true,
        stance: 'background',
        indexEnabled: true,
      })
    ).toBeNull();
  });
});

describe('readingNotesExclusionReason — pas de raison « portée » : une sélection restreint les notes, elle ne les écarte pas', () => {
  const open = (over: Partial<RAGQueryParams> = {}): RAGQueryParams => ({ ...make(true, true, true), ...over });
  /** Case effective, index actif, fournisseur local : le cas nominal. */
  const nominal = {
    readingNotesEffective: true,
    indexEnabled: true,
    cloudConsent: false,
    generationIsCloud: false,
  };

  it('consultées dans une recherche ouverte, case effective, fournisseur local', () => {
    expect(readingNotesExclusionReason({ params: open(), ...nominal })).toBeNull();
  });

  it('écartées sans index, quoi que dise la case', () => {
    expect(readingNotesExclusionReason({ params: open(), ...nominal, indexEnabled: false })).toBe('disabled');
  });

  it('écartées par un fournisseur distant sans consentement ; consultées dès qu’il est donné', () => {
    expect(readingNotesExclusionReason({ params: open(), ...nominal, generationIsCloud: true })).toBe('cloud');
    expect(
      readingNotesExclusionReason({ params: open(), ...nominal, generationIsCloud: true, cloudConsent: true })
    ).toBeNull();
    // Le consentement n'a pas d'objet quand le fournisseur est local.
    expect(readingNotesExclusionReason({ params: open(), ...nominal, cloudConsent: false })).toBeNull();
  });

  it('jamais écartées par une recherche restreinte : notes Obsidian seules, documents choisis, collection', () => {
    expect(
      readingNotesExclusionReason({
        params: open({ includeBibliography: false, includePrimary: false }),
        ...nominal,
      })
    ).toBeNull();
    expect(readingNotesExclusionReason({ params: open({ selectedDocumentIds: ['d1'] }), ...nominal })).toBeNull();
    expect(readingNotesExclusionReason({ params: open({ selectedCollectionKeys: ['K'] }), ...nominal })).toBeNull();
    // Même avec une posture qui les tolère : la portée ne joue jamais.
    expect(
      readingNotesExclusionReason({
        params: open({ selectedDocumentIds: ['d1'], selectedCollectionKeys: ['K'] }),
        ...nominal,
        stance: 'background',
      })
    ).toBeNull();
  });

  it('notes seules, ou manuscrit + notes : consultées, c’est la portée demandée, même en posture « off »', () => {
    const ownTextOnly = open({ includeBibliography: false, includePrimary: false, includeNotes: false });
    expect(readingNotesExclusionReason({ params: ownTextOnly, ...nominal })).toBeNull();
    expect(readingNotesExclusionReason({ params: ownTextOnly, ...nominal, stance: 'off' })).toBeNull();
  });

  it('écartées par la case, puis par la posture « off » du mode', () => {
    expect(readingNotesExclusionReason({ params: open(), ...nominal, readingNotesEffective: false })).toBe('toggle');
    expect(readingNotesExclusionReason({ params: open(), ...nominal, stance: 'off' })).toBe('stance');
    expect(readingNotesExclusionReason({ params: open(), ...nominal, stance: 'background' })).toBeNull();
    expect(readingNotesExclusionReason({ params: open(), ...nominal, stance: 'recall' })).toBeNull();
  });

  it('« index désactivé » prime sur « fournisseur distant », qui prime sur la case', () => {
    expect(
      readingNotesExclusionReason({
        params: open(),
        ...nominal,
        indexEnabled: false,
        generationIsCloud: true,
        readingNotesEffective: false,
      })
    ).toBe('disabled');
    expect(
      readingNotesExclusionReason({
        params: open(),
        ...nominal,
        generationIsCloud: true,
        readingNotesEffective: false,
      })
    ).toBe('cloud');
  });
});

describe('readingNotesStance — la posture des notes retombe sur celle du manuscrit', () => {
  it('suit `ragOverrides.readingNotes` quand il existe, sinon `ragOverrides.manuscript`', () => {
    expect(readingNotesStance(undefined)).toBeUndefined();
    expect(readingNotesStance({})).toBeUndefined();
    expect(readingNotesStance({ manuscript: 'off' })).toBe('off');
    expect(readingNotesStance({ readingNotes: 'off' })).toBe('off');
    expect(readingNotesStance({ manuscript: 'off', readingNotes: 'recall' })).toBe('recall');
    expect(readingNotesStance({ manuscript: 'recall', readingNotes: 'off' })).toBe('off');
  });
});
