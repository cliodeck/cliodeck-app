/**
 * La bibliographie dont l'index se reconstruit est « en indexation », pas en échec (E3).
 *
 * Vrai `retrievalService`, vrai `EnhancedVectorStore` sur un vrai projet qui a un PDF indexé ; seul le
 * fournisseur d'embeddings est simulé. La reconstruction en cours est l'état du magasin
 * (`isRebuilding`), posé à la main : une vraie reconstruction d'un si petit index finit avant que la
 * question n'atteigne le magasin. `EnhancedVectorStore.building.test.ts` la lance pour de vrai.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, dialog: {} }));

vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../backend/core/llm/providers/cliodeck-config-adapter.js')>();
  return {
    ...original,
    createRegistryFromClioDeckConfig: () => ({
      getLLM: () => ({}),
      getEmbedding: () => ({
        id: 'fake-embed:index-en-construction',
        embed: async (texts: string[]) => texts.map(() => Array(768).fill(0.1)),
      }),
      dispose: async () => undefined,
    }),
  };
});

import { EnhancedVectorStore } from '../../../../backend/core/vector-store/EnhancedVectorStore.js';
import { configManager } from '../config-manager.js';
import { retrievalService } from '../retrieval-service.js';
import { manuscriptIndexService } from '../manuscript-index-service.js';
import { readingNotesIndexService } from '../reading-notes-index-service.js';
import { seedPdf } from './helpers/seed-corpora.js';

let project = '';
let store: EnhancedVectorStore | null = null;
let turn = 0;
const question = (): string => `question ${++turn} sur la grève des dockers`;
const rebuilding = (value: boolean): void => {
  (store as unknown as { isRebuilding: boolean }).isRebuilding = value;
};

beforeEach(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-index-en-construction-'));
  vi.spyOn(configManager, 'getLLMConfig').mockReturnValue({ backend: 'ollama', ollamaURL: 'http://localhost:11434', ollamaChatModel: 'test' } as ReturnType<typeof configManager.getLLMConfig>);
  vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({ topK: 5, similarityThreshold: 0.12 } as ReturnType<typeof configManager.getRAGConfig>);
  vi.spyOn(manuscriptIndexService, 'isEnabled').mockReturnValue(false);
  vi.spyOn(readingNotesIndexService, 'isEnabled').mockReturnValue(false);
  store = new EnhancedVectorStore(project);
  await store.initialize();
  await seedPdf(store, project);
  retrievalService.configure({ vectorStore: store, workspaceRoot: project });
});

afterEach(() => {
  rebuilding(false);
  retrievalService.clear();
  manuscriptIndexService.clear();
  store?.close();
  store = null;
  vi.restoreAllMocks();
  fs.rmSync(project, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('bibliographie dont l’index se reconstruit (E3)', () => {
  it('« en indexation », pas en échec, jusqu’au panneau d’explication', async () => {
    rebuilding(true);
    const { outcomes, stats } = await retrievalService.searchWithStats({ query: question(), sourceType: 'secondary' });
    expect(outcomes.find((o) => o.source === 'secondary')).toMatchObject({
      attempted: true,
      ok: false,
      indexing: true,
      hitCount: 0,
    });
    expect(stats.search.corpora.find((c) => c.source === 'secondary')).toMatchObject({ ok: false, indexing: true });
  });

  it('témoin : la reconstruction finie, la bibliographie répond', async () => {
    const { outcomes, stats } = await retrievalService.searchWithStats({ query: question(), sourceType: 'secondary' });
    expect(outcomes.find((o) => o.source === 'secondary')).toMatchObject({ attempted: true, ok: true, hitCount: 1 });
    expect(stats.search.corpora.find((c) => c.source === 'secondary')?.indexing).toBeUndefined();
  });
});
