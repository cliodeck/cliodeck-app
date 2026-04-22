/**
 * Fusion retrieval routing — asserts that the fusion-chat adapter honors
 * the 7-case source-selection truth table defined by
 * `getResolvedSourceType` (src/renderer/src/stores/ragQueryStore.ts).
 *
 * Covers both levels:
 *   1. `resolveRetrievalArgs` — the pure adapter that maps engine-level
 *      options to `RetrievalService.searchWithStats` args.
 *   2. `RetrievalService.search` branch dispatch — we mock
 *      `searchSecondary` / `searchPrimary` / `searchVault` via spies on
 *      the dependencies so we can assert which corpora are touched per
 *      combination. The goal is to prove that `{sourceType:'vault'}` does
 *      NOT hit PDF or Tropy, and that the six other combinations hit
 *      exactly the right stores.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveRetrievalArgs } from '../fusion-chat-service.js';
import { retrievalService } from '../retrieval-service.js';

describe('resolveRetrievalArgs (7-case truth table)', () => {
  // UI combinations ↔ expected { sourceType, includeVault } pair the
  // resolver in `ragQueryStore` produces and the adapter must forward.
  const cases: Array<{
    name: string;
    input: {
      sourceType: 'primary' | 'secondary' | 'both' | 'vault';
      includeVault: boolean;
    };
    expected: {
      sourceType: 'primary' | 'secondary' | 'both' | 'vault';
      includeVault: boolean;
    };
  }> = [
    {
      name: 'biblio only → PDF only',
      input: { sourceType: 'secondary', includeVault: false },
      expected: { sourceType: 'secondary', includeVault: false },
    },
    {
      name: 'primary only → Tropy only',
      input: { sourceType: 'primary', includeVault: false },
      expected: { sourceType: 'primary', includeVault: false },
    },
    {
      name: 'notes only → vault only',
      input: { sourceType: 'vault', includeVault: true },
      expected: { sourceType: 'vault', includeVault: true },
    },
    {
      name: 'biblio + primary → PDF + Tropy, no vault',
      input: { sourceType: 'both', includeVault: false },
      expected: { sourceType: 'both', includeVault: false },
    },
    {
      name: 'biblio + notes → PDF + vault, no Tropy',
      input: { sourceType: 'secondary', includeVault: true },
      expected: { sourceType: 'secondary', includeVault: true },
    },
    {
      name: 'primary + notes → Tropy + vault, no PDF',
      input: { sourceType: 'primary', includeVault: true },
      expected: { sourceType: 'primary', includeVault: true },
    },
    {
      name: 'all three → PDF + Tropy + vault',
      input: { sourceType: 'both', includeVault: true },
      expected: { sourceType: 'both', includeVault: true },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveRetrievalArgs(c.input)).toEqual(c.expected);
    });
  }

  it('vault sourceType forces includeVault=true regardless of input', () => {
    expect(resolveRetrievalArgs({ sourceType: 'vault', includeVault: false })).toEqual({
      sourceType: 'vault',
      includeVault: true,
    });
  });

  it('defaults to "both" + vault-off when options are missing (no silent widening)', () => {
    expect(resolveRetrievalArgs(undefined)).toEqual({
      sourceType: 'both',
      includeVault: false,
    });
    expect(resolveRetrievalArgs({})).toEqual({
      sourceType: 'both',
      includeVault: false,
    });
  });
});

/**
 * Branch-dispatch tests on `RetrievalService.search`. We swap the
 * service's private branch helpers via spies to record which branches
 * the public entry-point exercises. This is a white-box test: it keeps
 * the test payload small (fake vectorStore / providerManager) while
 * asserting the exact routing invariants documented in
 * `retrieval-service.ts` (§`sourceType === 'secondary' || 'both'`,
 * `sourceType === 'primary' || 'both'`, `includeVault || sourceType ===
 * 'vault'`).
 */
describe('RetrievalService.search — branch dispatch', () => {
  // Access the private methods via `any`-free bracket indexing. The
  // compiler discipline here matches the "no any" CLAUDE.md rule by
  // using a locally-widened unknown view of the service instance.
  type PrivateBranches = {
    searchSecondary: (q: string, o?: unknown) => Promise<unknown[]>;
    searchVault: (q: string, o: { topK: number }) => Promise<unknown[]>;
  };
  const asPrivate = (): PrivateBranches =>
    retrievalService as unknown as PrivateBranches;

  let secondarySpy: ReturnType<typeof vi.fn>;
  let vaultSpy: ReturnType<typeof vi.fn>;
  let tropySpy: ReturnType<typeof vi.fn>;
  let ensureReadySpy: ReturnType<typeof vi.spyOn>;
  // Cache originals so we can restore between cases and avoid bleed.
  let originalSecondary: PrivateBranches['searchSecondary'];
  let originalVault: PrivateBranches['searchVault'];

  beforeEach(async () => {
    // Silence the "not configured" guard — we don't need a real store.
    ensureReadySpy = vi
      .spyOn(
        retrievalService as unknown as { ensureReady: () => void },
        'ensureReady'
      )
      .mockImplementation(() => undefined);

    // `search` reads topK / similarityThreshold from the user config. We
    // don't init electron-store in unit tests, so stub getRAGConfig.
    const { configManager } = await import('../config-manager.js');
    vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({
      topK: 5,
      similarityThreshold: 0,
    } as ReturnType<typeof configManager.getRAGConfig>);

    originalSecondary = asPrivate().searchSecondary.bind(retrievalService);
    originalVault = asPrivate().searchVault.bind(retrievalService);

    secondarySpy = vi.fn().mockResolvedValue([]);
    vaultSpy = vi.fn().mockResolvedValue([]);
    (retrievalService as unknown as PrivateBranches).searchSecondary =
      secondarySpy as unknown as PrivateBranches['searchSecondary'];
    (retrievalService as unknown as PrivateBranches).searchVault =
      vaultSpy as unknown as PrivateBranches['searchVault'];

    // tropyService is imported by the module; stub via dynamic import.
    const { tropyService } = await import('../tropy-service.js');
    tropySpy = vi.fn().mockResolvedValue([]);
    (tropyService as unknown as { search: unknown }).search = tropySpy;
  });

  afterEach(() => {
    ensureReadySpy.mockRestore();
    (retrievalService as unknown as PrivateBranches).searchSecondary =
      originalSecondary;
    (retrievalService as unknown as PrivateBranches).searchVault =
      originalVault;
  });

  const run = async (
    sourceType: 'primary' | 'secondary' | 'both' | 'vault',
    includeVault: boolean
  ): Promise<void> => {
    await retrievalService.search({
      query: 'q',
      sourceType,
      includeVault,
      topK: 5,
    });
  };

  it('vault-only: hits vault, skips PDF and Tropy', async () => {
    await run('vault', true);
    expect(vaultSpy).toHaveBeenCalledTimes(1);
    expect(secondarySpy).not.toHaveBeenCalled();
    expect(tropySpy).not.toHaveBeenCalled();
  });

  it('secondary-only (biblio): hits PDF only', async () => {
    await run('secondary', false);
    expect(secondarySpy).toHaveBeenCalledTimes(1);
    expect(tropySpy).not.toHaveBeenCalled();
    expect(vaultSpy).not.toHaveBeenCalled();
  });

  it('primary-only (archives): hits Tropy only', async () => {
    await run('primary', false);
    expect(tropySpy).toHaveBeenCalledTimes(1);
    expect(secondarySpy).not.toHaveBeenCalled();
    expect(vaultSpy).not.toHaveBeenCalled();
  });

  it('both (biblio+primary): hits PDF + Tropy, skips vault', async () => {
    await run('both', false);
    expect(secondarySpy).toHaveBeenCalledTimes(1);
    expect(tropySpy).toHaveBeenCalledTimes(1);
    expect(vaultSpy).not.toHaveBeenCalled();
  });

  it('secondary + includeVault (biblio+notes): hits PDF + vault, skips Tropy', async () => {
    await run('secondary', true);
    expect(secondarySpy).toHaveBeenCalledTimes(1);
    expect(vaultSpy).toHaveBeenCalledTimes(1);
    expect(tropySpy).not.toHaveBeenCalled();
  });

  it('primary + includeVault (archives+notes): hits Tropy + vault, skips PDF', async () => {
    await run('primary', true);
    expect(tropySpy).toHaveBeenCalledTimes(1);
    expect(vaultSpy).toHaveBeenCalledTimes(1);
    expect(secondarySpy).not.toHaveBeenCalled();
  });

  it('both + includeVault (all three): hits PDF + Tropy + vault', async () => {
    await run('both', true);
    expect(secondarySpy).toHaveBeenCalledTimes(1);
    expect(tropySpy).toHaveBeenCalledTimes(1);
    expect(vaultSpy).toHaveBeenCalledTimes(1);
  });

  // Regression: the previous implementation split topK across sources
  // (0.6/0.4/0.4), which wasted budget on empty sources. A project with
  // PDFs only would lose 40% of its slots to an unused Tropy branch.
  // Each active source must now be queried for the full topK; the final
  // `sort().slice(0, topK)` keeps the best chunks by similarity overall.
  describe('topK budget (no fractional split across sources)', () => {
    const topKOf = (spy: ReturnType<typeof vi.fn>): number => {
      const call = spy.mock.calls[0];
      const opts = call?.[1] as { topK?: number } | undefined;
      return opts?.topK ?? -1;
    };

    it('both: PDF and Tropy each get full topK', async () => {
      await run('both', false);
      expect(topKOf(secondarySpy)).toBe(5);
      expect(topKOf(tropySpy)).toBe(5);
    });

    it('both + includeVault: all three sources each get full topK', async () => {
      await run('both', true);
      expect(topKOf(secondarySpy)).toBe(5);
      expect(topKOf(tropySpy)).toBe(5);
      expect(topKOf(vaultSpy)).toBe(5);
    });

    it('secondary-only: PDF gets full topK (unchanged)', async () => {
      await run('secondary', false);
      expect(topKOf(secondarySpy)).toBe(5);
    });
  });
});
