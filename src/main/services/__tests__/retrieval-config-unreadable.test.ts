/**
 * Ce que `project.configUnreadable` dit du chat, mesuré.
 *
 * `config.json` illisible n'éteint pas le coffre : ses notes sont dans `brain.db`, et la recherche
 * ne lit `config.json` que pour le mode de sécurité. Un auteur qui a choisi Bloquer a donc ses
 * notes envoyées au modèle, sous le mode Avertir. Le message le dit. Si ce test tombe parce que ce
 * comportement a changé, c'est aussi ce message qu'il faut changer, dans les trois locales.
 *
 * Vrai `retrievalService`, vrai fichier ; seul le magasin du coffre est simulé, pour se passer du
 * binding natif.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

const { vaultSearch } = vi.hoisted(() => ({ vaultSearch: vi.fn() }));

vi.mock('../../../../backend/integrations/obsidian/ObsidianVaultStore.js', () => ({
  ObsidianVaultStore: class {
    search = vaultSearch;
    close(): void {
      /* rien d'ouvert */
    }
  },
}));

import { retrievalService } from '../retrieval-service.js';
import { configManager } from '../config-manager.js';

interface Internals {
  workspaceRoot: string | null;
  vaultStore: unknown;
  refreshInspectorMode(): Promise<void>;
  ensureReady(): void;
  getQueryEmbedding(query: string): Promise<Float32Array>;
}

const internals = retrievalService as unknown as Internals;
let root: string;

const NOTE_HIT = {
  chunk: { id: 'c1', content: 'Une note du coffre.', noteId: 'n1', chunkIndex: 0 },
  note: { id: 'n1', title: 'Note', relativePath: 'note.md' },
  signals: { dense: 0.9, lexicalRank: 1 },
  score: 0.016,
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-retrieval-config-'));
  mkdirSync(path.join(root, '.cliodeck'), { recursive: true });
  writeFileSync(path.join(root, '.cliodeck', 'brain.db'), '');

  vaultSearch.mockReset().mockReturnValue([NOTE_HIT]);
  vi.spyOn(internals, 'ensureReady').mockImplementation(() => undefined);
  vi.spyOn(internals, 'getQueryEmbedding').mockResolvedValue(new Float32Array(1));
  vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({
    topK: 5,
    similarityThreshold: 0,
  } as ReturnType<typeof configManager.getRAGConfig>);
  internals.workspaceRoot = root;
  internals.vaultStore = null;
});

afterEach(async () => {
  internals.workspaceRoot = null;
  internals.vaultStore = null;
  await internals.refreshInspectorMode();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe.each<[string, string]>([
  ['virgule en trop', '{"schema_version":2,"security":{"sourceInspectorMode":"block"},}'],
  ['format plus récent', '{"schema_version":3,"security":{"sourceInspectorMode":"block"}}'],
])('config.json illisible (%s), mode Bloquer choisi', (_label, content) => {
  beforeEach(async () => {
    writeFileSync(path.join(root, '.cliodeck', 'config.json'), content);
    await internals.refreshInspectorMode();
  });

  it('le mode appliqué est Avertir', () => {
    expect(retrievalService.getInspectorMode()).toBe('warn');
  });

  it('les notes déjà indexées restent cherchées et rendues', async () => {
    const result = await retrievalService.search({ query: 'q', sourceType: 'vault' });

    expect(vaultSearch).toHaveBeenCalledTimes(1);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.chunk.content).toBe('Une note du coffre.');
    expect(result.outcomes.find((o) => o.source === 'vault')).toMatchObject({ attempted: true, ok: true, hitCount: 1 });
  });
});

it('témoin : un config.json qui se lit garde le mode choisi', async () => {
  writeFileSync(
    path.join(root, '.cliodeck', 'config.json'),
    '{"schema_version":2,"security":{"sourceInspectorMode":"block"}}'
  );
  await internals.refreshInspectorMode();
  expect(retrievalService.getInspectorMode()).toBe('block');
});
