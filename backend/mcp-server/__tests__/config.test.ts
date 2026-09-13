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
  writeWorkspaceConfig,
} from '../../core/workspace/config.js';
import { isToolEnabled, loadMCPConfig } from '../config.js';

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
    expect(() => loadMCPConfig(tmp)).toThrow(/schema_version/);
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
