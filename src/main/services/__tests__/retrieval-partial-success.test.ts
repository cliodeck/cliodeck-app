/**
 * Partial-success retrieval (fusion 1.7).
 *
 * `RetrievalService.search` now returns a typed `{ hits, outcomes }`
 * envelope. Each retrieval call always reports the per-corpus outcome
 * (secondary / primary / vault) so a Tropy crash doesn't silently
 * erase the bibliography hits the same query produced.
 *
 * The tests mock the three internal branch points that `search()`
 * dispatches to (`searchSecondary` / `tropyService.search` /
 * `searchVault`) to keep the suite fast and deterministic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retrievalService } from '../retrieval-service.js';

interface PrivateBranches {
  searchSecondary: (...args: unknown[]) => Promise<unknown>;
  searchVault: (...args: unknown[]) => Promise<unknown>;
  inspectAndFilter: <T>(r: T[]) => T[];
  ensureReady: () => void;
}

// Helper: fake a chunk in the shape `searchSecondary` returns.
function fakeSecondaryHit(id: string, similarity = 0.9): unknown {
  return {
    chunk: { id, content: `content ${id}`, documentId: 'doc1', chunkIndex: 0 },
    document: { id: 'doc1', title: 'doc1', author: null, bibtexKey: 'k' },
    similarity,
  };
}

describe('RetrievalService partial-success envelope (1.7)', () => {
  let originalSecondary: PrivateBranches['searchSecondary'];
  let originalVault: PrivateBranches['searchVault'];
  let ensureReadySpy: ReturnType<typeof vi.spyOn>;
  let inspectSpy: ReturnType<typeof vi.spyOn>;
  let secondarySpy: ReturnType<typeof vi.fn>;
  let vaultSpy: ReturnType<typeof vi.fn>;
  let tropySpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Bypass the configure()/dependency check so the test exercises only
    // the branching logic.
    ensureReadySpy = vi
      .spyOn(retrievalService as unknown as PrivateBranches, 'ensureReady')
      .mockImplementation(() => undefined);
    // Pass-through inspector — partial-success behaviour is orthogonal.
    inspectSpy = vi
      .spyOn(retrievalService as unknown as PrivateBranches, 'inspectAndFilter')
      .mockImplementation(<T,>(r: T[]) => r);

    // `search` reads topK / similarityThreshold from the user config; we
    // don't init electron-store in unit tests, so stub getRAGConfig.
    const { configManager } = await import('../config-manager.js');
    vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({
      topK: 5,
      similarityThreshold: 0,
    } as ReturnType<typeof configManager.getRAGConfig>);

    // Replace the two private corpus methods with vi.fn() spies so each
    // test can fail / succeed them at will.
    originalSecondary = (
      retrievalService as unknown as PrivateBranches
    ).searchSecondary;
    originalVault = (retrievalService as unknown as PrivateBranches).searchVault;
    secondarySpy = vi.fn(async () => [fakeSecondaryHit('a')]);
    vaultSpy = vi.fn(async () => []);
    (retrievalService as unknown as PrivateBranches).searchSecondary =
      secondarySpy as unknown as PrivateBranches['searchSecondary'];
    (retrievalService as unknown as PrivateBranches).searchVault =
      vaultSpy as unknown as PrivateBranches['searchVault'];

    // Spy on the third branch — `tropyService.search` — through the real
    // singleton so the call site's `import` resolves to our stub.
    const tropy = await import('../tropy-service.js');
    tropySpy = vi.fn(async () => []);
    (tropy.tropyService as unknown as { search: unknown }).search = tropySpy;
  });

  afterEach(() => {
    ensureReadySpy.mockRestore();
    inspectSpy.mockRestore();
    (retrievalService as unknown as PrivateBranches).searchSecondary =
      originalSecondary;
    (retrievalService as unknown as PrivateBranches).searchVault = originalVault;
    vi.restoreAllMocks();
  });

  it('reports outcomes for all three corpora, marking unattempted ones', async () => {
    const result = await retrievalService.search({
      query: 'q',
      sourceType: 'secondary',
      includeVault: false,
    });
    expect(result.outcomes).toHaveLength(3);
    const map = Object.fromEntries(result.outcomes.map((o) => [o.source, o]));
    expect(map.secondary.attempted).toBe(true);
    expect(map.secondary.ok).toBe(true);
    expect(map.secondary.hitCount).toBe(1);
    expect(map.primary.attempted).toBe(false);
    expect(map.primary.ok).toBe(false);
    expect(map.vault.attempted).toBe(false);
  });

  it('preserves successful corpora when one corpus throws (partial success)', async () => {
    // Secondary is healthy, primary blows up. Hits from secondary must
    // still come through, primary outcome must record the error.
    secondarySpy.mockResolvedValueOnce([fakeSecondaryHit('a'), fakeSecondaryHit('b')]);
    tropySpy.mockRejectedValueOnce(new Error('Tropy not initialised'));

    const result = await retrievalService.search({
      query: 'q',
      sourceType: 'both',
      includeVault: false,
    });
    expect(result.hits).toHaveLength(2);
    const map = Object.fromEntries(result.outcomes.map((o) => [o.source, o]));
    expect(map.secondary.ok).toBe(true);
    expect(map.secondary.hitCount).toBe(2);
    expect(map.primary.ok).toBe(false);
    expect(map.primary.error).toBe('Tropy not initialised');
    expect(map.vault.attempted).toBe(false);
  });

  it('records outcomes for vault-only mode, regardless of includeVault flag', async () => {
    vaultSpy.mockResolvedValueOnce([
      {
        chunk: { id: 'v1', content: 'note', documentId: 'note1', chunkIndex: 0 },
        document: { id: 'note1', title: 'note1', author: null, bibtexKey: null },
        source: { kind: 'obsidian-note', relativePath: 'a.md', noteId: 'note1' },
        similarity: 0.7,
        sourceType: 'vault' as const,
      },
    ]);

    const result = await retrievalService.search({
      query: 'q',
      sourceType: 'vault',
      includeVault: false, // vault-only mode forces vault inclusion anyway
    });
    expect(result.hits).toHaveLength(1);
    const map = Object.fromEntries(result.outcomes.map((o) => [o.source, o]));
    expect(map.vault.attempted).toBe(true);
    expect(map.vault.ok).toBe(true);
    expect(map.vault.hitCount).toBe(1);
    expect(map.secondary.attempted).toBe(false);
    expect(map.primary.attempted).toBe(false);
  });

  it('captures durationMs for each attempted corpus', async () => {
    secondarySpy.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [];
    });
    const result = await retrievalService.search({
      query: 'q',
      sourceType: 'secondary',
    });
    const sec = result.outcomes.find((o) => o.source === 'secondary')!;
    expect(sec.attempted).toBe(true);
    expect(typeof sec.durationMs).toBe('number');
    expect(sec.durationMs).toBeGreaterThanOrEqual(0);
  });
});
