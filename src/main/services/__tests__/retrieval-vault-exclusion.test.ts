/**
 * S09-1-13, côté recherche : un index du coffre construit avant le correctif contient encore
 * `reading-notes/*.md` et `document.md`. Ces extraits n'atteignent plus le résultat du canal
 * « vault », sans attendre une réindexation : le consentement des notes de lecture et la
 * politique du manuscrit ne s'appliquent qu'à leurs propres canaux.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { retrievalService } from '../retrieval-service.js';
import { configManager } from '../config-manager.js';

type Internals = {
  ensureReady: () => void;
  inspectAndFilter: <T>(r: T[]) => { results: T[]; securityEvents: unknown[] };
  getVaultStore: () => unknown;
  getQueryEmbedding: (q: string) => Promise<Float32Array>;
  workspaceRoot: string | null;
};

function vaultHit(relativePath: string, vaultPath: string) {
  return {
    chunk: { id: relativePath, noteId: `note-${relativePath}`, chunkIndex: 0, content: relativePath, startPosition: 0, endPosition: 1 },
    note: { id: `note-${relativePath}`, title: relativePath, relativePath, vaultPath },
    score: 0.016,
    signals: { dense: 0.6, lexical: 3, lexicalRank: 1 },
  };
}

describe('RetrievalService — coffre qui contient le projet', () => {
  const internals = retrievalService as unknown as Internals;
  let vault = '';
  let previousRoot: string | null = null;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-coffre-recherche-'));
    const project = path.join(vault, 'these');
    fs.mkdirSync(path.join(project, 'reading-notes'), { recursive: true });
    fs.writeFileSync(path.join(project, 'reading-notes', 'Braudel_1949.md'), '# Braudel\n');
    fs.writeFileSync(path.join(project, 'document.md'), '# Article\n');
    previousRoot = internals.workspaceRoot;
    internals.workspaceRoot = project;

    vi.spyOn(internals, 'ensureReady').mockImplementation(() => undefined);
    vi.spyOn(internals, 'inspectAndFilter').mockImplementation(<T,>(r: T[]) => ({
      results: r,
      securityEvents: [],
    }));
    vi.spyOn(internals, 'getQueryEmbedding').mockResolvedValue(new Float32Array([1, 0]));
    vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({
      topK: 5,
      similarityThreshold: 0.12,
    } as ReturnType<typeof configManager.getRAGConfig>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    internals.workspaceRoot = previousRoot;
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('un extrait reading-notes/ ou document.md d’un index existant n’atteint pas le résultat', async () => {
    vi.spyOn(internals, 'getVaultStore').mockReturnValue({
      search: () => [
        vaultHit('these/reading-notes/Braudel_1949.md', vault),
        vaultHit('these/document.md', vault),
        vaultHit('Journal/2026-11-06.md', vault),
      ],
    });

    const { hits } = await retrievalService.search({ query: 'Braudel', sourceType: 'vault' });

    const paths = hits.map((h) => (h.sourceType === 'vault' ? h.source.relativePath : null));
    expect(paths).toEqual(['Journal/2026-11-06.md']);
  });

  it('un coffre disjoint du projet garde toutes ses notes', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-autre-coffre-'));
    try {
      vi.spyOn(internals, 'getVaultStore').mockReturnValue({
        search: () => [vaultHit('reading-notes/a.md', other), vaultHit('document.md', other)],
      });
      const { hits } = await retrievalService.search({ query: 'q', sourceType: 'vault' });
      expect(hits).toHaveLength(2);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
