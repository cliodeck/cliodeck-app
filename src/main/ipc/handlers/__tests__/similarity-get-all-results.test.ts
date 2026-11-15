/**
 * `similarity:get-all-results` reçoit le texte du document ouvert (S13-1-3).
 *
 * Le canal ne prenait rien, et rendait l'analyse du dernier texte analysé à chaque ouverture du
 * panneau : dans un livre, les segments du chapitre 1 sur le chapitre 2. Il reçoit maintenant le
 * texte, et ne rend que ses segments ; sans texte, rien.
 *
 * Vrais handlers, vrai service, vrai fichier de cache dans un projet temporaire. La recherche et
 * l'état des corpus sont simulés.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  projectPath: '' as string,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { fromWebContents: () => null },
}));
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: { getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:9' }) },
}));
vi.mock('../../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => ({ getLLM: () => null, dispose: async () => undefined }),
}));
vi.mock('../../../services/pdf-service.js', () => ({
  pdfService: {
    search: async () => [
      { sourceType: 'secondary', similarity: 0.5, document: { id: 'pdf-a', title: 'A' }, chunk: { content: 'Extrait' } },
    ],
    getIndexFreshness: () => ({ documentCount: 1, chunkCount: 1, lastIndexedAt: '2026-11-14T09:00:00.000Z', rebuildDue: false }),
  },
}));
vi.mock('../../../services/tropy-service.js', () => ({ tropyService: { getIndexFreshness: () => null } }));

import { setupSimilarityHandlers } from '../similarity-handlers.js';

setupSimilarityHandlers();

const CHAPTER_1 = '# Chapitre 1\n\nLe préfet Chiappe est muté au Maroc en février 1934.';
const CHAPTER_2 = '# Chapitre 2\n\nLe Front populaire gagne les élections de mai 1936.';

type Response = { success: boolean; results?: Array<{ segmentId: string }>; error?: string };

function invoke(channel: string, ...args: unknown[]): Promise<Response> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`handler absent : ${channel}`);
  return fn({ sender: {} }, ...args) as Promise<Response>;
}

beforeEach(() => {
  h.projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-similarite-ipc-'));
  fs.mkdirSync(path.join(h.projectPath, '.cliodeck'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(h.projectPath, { recursive: true, force: true });
});

describe('similarity:get-all-results', () => {
  it('ne rend que les segments du texte reçu', async () => {
    const analysed = await invoke('similarity:analyze', CHAPTER_1, { useReranking: false });
    expect(analysed.success).toBe(true);

    const same = await invoke('similarity:get-all-results', CHAPTER_1);
    const other = await invoke('similarity:get-all-results', CHAPTER_2);

    expect(same.results?.map((r) => r.segmentId)).toEqual(analysed.results?.map((r) => r.segmentId));
    expect(other).toEqual({ success: true, results: [] });
  });

  it('sans texte : une liste vide', async () => {
    await invoke('similarity:analyze', CHAPTER_1, { useReranking: false });

    expect(await invoke('similarity:get-all-results')).toEqual({ success: true, results: [] });
  });
});
