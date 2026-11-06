import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  ensureWorkspaceDirectories,
  workspaceFiles,
  workspacePaths,
} from '../../core/workspace/layout.js';
import {
  defaultWorkspaceConfig,
  readWorkspaceConfig,
  WorkspaceConfigError,
  writeWorkspaceConfig,
} from '../../core/workspace/config.js';
import { isToolEnabled, loadMCPConfig } from '../config.js';
import { symlinkAvailable } from '../../__tests__/helpers/native-guards.js';

let tmp = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-cfg-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('loadMCPConfig (2.5)', () => {
  it('throws when no workspace exists', () => {
    expect(() => loadMCPConfig(tmp)).toThrow(/No ClioDeck workspace/);
  });

  it('throws a guidance error when workspace is still on legacy-subdir layout', async () => {
    const legacyV2 = path.join(workspacePaths(tmp).legacyV2Dir, 'config.json');
    await fs.mkdir(path.dirname(legacyV2), { recursive: true });
    await fs.writeFile(legacyV2, JSON.stringify({ schema_version: 2 }));
    expect(() => loadMCPConfig(tmp)).toThrow(/legacy \.cliodeck\/v2\//);
  });

  it('refuses to start when mcpServer.enabled is missing', async () => {
    await ensureWorkspaceDirectories(tmp);
    await writeWorkspaceConfig(tmp, defaultWorkspaceConfig('demo'));
    expect(() => loadMCPConfig(tmp)).toThrow(/disabled/);
  });

  it('refuses to start when mcpServer.enabled is false', async () => {
    await ensureWorkspaceDirectories(tmp);
    await writeWorkspaceConfig(tmp, {
      ...defaultWorkspaceConfig('demo'),
      mcpServer: { enabled: false },
    } as never);
    expect(() => loadMCPConfig(tmp)).toThrow(/disabled/);
  });

  it('returns runtime config when explicitly enabled', async () => {
    await ensureWorkspaceDirectories(tmp);
    await writeWorkspaceConfig(tmp, {
      ...defaultWorkspaceConfig('demo'),
      mcpServer: { enabled: true, serverName: 'my-corpus' },
    } as never);
    const cfg = loadMCPConfig(tmp);
    expect(cfg.mcp.enabled).toBe(true);
    expect(cfg.mcp.serverName).toBe('my-corpus');
    expect(cfg.paths.mcpAccessLog).toBe(workspaceFiles(tmp).mcpAccessLog);
  });

  it('rejects newer schema_version', async () => {
    await ensureWorkspaceDirectories(tmp);
    const p = workspaceFiles(tmp);
    await fs.writeFile(p.config, JSON.stringify({ schema_version: 99 }));
    expect(() => loadMCPConfig(tmp)).toThrow(/version plus récente/);
  });
});

/**
 * L'app et le serveur lisent le même fichier, sous le même contrat : sinon les Réglages disent
 * « activé » et le client externe échoue, sur un message qui ne veut rien dire.
 */
describe('loadMCPConfig lit config.json comme l’app', () => {
  const ENABLED = { mcpServer: { enabled: true } };

  async function writeRaw(content: string): Promise<void> {
    await ensureWorkspaceDirectories(tmp);
    await fs.writeFile(workspaceFiles(tmp).config, content);
  }

  it.each<[string, string]>([
    ['un BOM en tête', `\uFEFF${JSON.stringify({ schema_version: 2, ...ENABLED })}`],
    ['schema_version "2" en texte', JSON.stringify({ schema_version: '2', ...ENABLED })],
    ['schema_version 1', JSON.stringify({ schema_version: 1, ...ENABLED })],
    ['sans schema_version', JSON.stringify(ENABLED)],
  ])('%s : accepté, comme dans l’app', async (_label, content) => {
    await writeRaw(content);
    const appSide = await readWorkspaceConfig(tmp);
    expect((appSide.mcpServer as { enabled: boolean }).enabled).toBe(true);

    const cfg = loadMCPConfig(tmp);

    expect(cfg.mcp.enabled).toBe(true);
    expect(cfg.workspace.schema_version).toBe(2);
  });

  it.each<[string, string, string]>([
    ['schema_version 3', JSON.stringify({ schema_version: 3, ...ENABLED }), 'newer_schema'],
    ['schema_version "3" en texte', JSON.stringify({ schema_version: '3', ...ENABLED }), 'newer_schema'],
    ['virgule en trop', '{"schema_version":2,"mcpServer":{"enabled":true},}', 'invalid_json'],
    ['un tableau', '[]', 'invalid_json'],
    ['null', 'null', 'invalid_json'],
  ])('%s : refusé, même motif que dans l’app', async (_label, content, kind) => {
    await writeRaw(content);
    expect(() => loadMCPConfig(tmp)).toThrow(WorkspaceConfigError);
    try {
      loadMCPConfig(tmp);
    } catch (error) {
      expect((error as WorkspaceConfigError).kind).toBe(kind);
    }
  });

  it.each<[string, string]>([
    ['0 octet', ''],
    ['des blancs', ' \n'],
    ['un BOM seul', '\uFEFF'],
  ])('%s : comme absent, et le serveur refuse de démarrer', async (_label, content) => {
    await writeRaw(content);
    expect(() => loadMCPConfig(tmp)).toThrow(/No ClioDeck workspace/);
  });

  it('pas en UTF-8 : refusé, comme dans l’app, plutôt que lu avec des U+FFFD', async () => {
    await ensureWorkspaceDirectories(tmp);
    await fs.writeFile(
      workspaceFiles(tmp).config,
      Buffer.from('{"name":"Th\xe8se","mcpServer":{"enabled":true}}', 'latin1')
    );
    await expect(readWorkspaceConfig(tmp)).rejects.toMatchObject({ kind: 'unreadable' });
    expect(() => loadMCPConfig(tmp)).toThrow();
  });

  it('lisible mais pas activé : le consentement reste exigé', async () => {
    await writeRaw(`\uFEFF${JSON.stringify({ schema_version: '2' })}`);
    expect(() => loadMCPConfig(tmp)).toThrow(/disabled/);
  });
});

describe('isToolEnabled', () => {
  it('exposes a tool that was never mentioned', () => {
    // L'absence vaut consentement : sinon la mise à jour couperait en silence
    // les neuf outils des projets qui avaient déjà activé le serveur.
    expect(isToolEnabled({ enabled: true }, 'search_documents')).toBe(true);
    expect(isToolEnabled({ enabled: true, tools: {} }, 'search_documents')).toBe(true);
  });

  it('withholds a tool refused explicitly', () => {
    expect(
      isToolEnabled({ enabled: true, tools: { search_documents: false } }, 'search_documents')
    ).toBe(false);
  });

  it('leaves the other tools alone', () => {
    const mcp = { enabled: true, tools: { search_documents: false } };
    expect(isToolEnabled(mcp, 'search_tropy')).toBe(true);
  });
});

/**
 * D18 : `.cliodeck` ou `brain.db` lié hors du projet. Le serveur lisait la base d'un autre projet
 * et l'exposait au client externe comme le corpus de celui-ci.
 */
describe.skipIf(!symlinkAvailable)('loadMCPConfig — espace de travail lié hors du projet', () => {
  let outside = '';

  beforeEach(async () => {
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-cfg-ailleurs-'));
  });
  afterEach(async () => {
    await fs.rm(outside, { recursive: true, force: true });
  });

  const enabled = { ...defaultWorkspaceConfig('autre'), mcpServer: { enabled: true } } as never;

  it('.cliodeck lié dehors : refusé, le chemin nommé', async () => {
    await ensureWorkspaceDirectories(outside);
    await writeWorkspaceConfig(outside, enabled);
    await fs.symlink(path.join(outside, '.cliodeck'), path.join(tmp, '.cliodeck'));

    expect(() => loadMCPConfig(tmp)).toThrow(/outside the project.*\.cliodeck/s);
  });

  it('brain.db seul lié dehors : refusé', async () => {
    await ensureWorkspaceDirectories(tmp);
    await writeWorkspaceConfig(tmp, enabled);
    await fs.writeFile(path.join(outside, 'brain.db'), '');
    await fs.symlink(path.join(outside, 'brain.db'), workspaceFiles(tmp).brainDb);

    expect(() => loadMCPConfig(tmp)).toThrow(/outside the project.*brain\.db/s);
  });
});
