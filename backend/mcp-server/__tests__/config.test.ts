import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ensureV2Directories, v2Paths } from '../../core/workspace/layout.js';
import {
  defaultWorkspaceConfig,
  writeWorkspaceConfig,
} from '../../core/workspace/config.js';
import { loadMCPConfig } from '../config.js';

let tmp = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-cfg-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('loadMCPConfig (2.5)', () => {
  it('throws when no v2 workspace exists', () => {
    expect(() => loadMCPConfig(tmp)).toThrow(/No ClioDeck v2 workspace/);
  });

  it('refuses to start when mcpServer.enabled is missing', async () => {
    await ensureV2Directories(tmp);
    await writeWorkspaceConfig(tmp, defaultWorkspaceConfig('demo'));
    expect(() => loadMCPConfig(tmp)).toThrow(/disabled/);
  });

  it('refuses to start when mcpServer.enabled is false', async () => {
    await ensureV2Directories(tmp);
    await writeWorkspaceConfig(tmp, {
      ...defaultWorkspaceConfig('demo'),
      mcpServer: { enabled: false },
    } as never);
    expect(() => loadMCPConfig(tmp)).toThrow(/disabled/);
  });

  it('returns runtime config when explicitly enabled', async () => {
    await ensureV2Directories(tmp);
    await writeWorkspaceConfig(tmp, {
      ...defaultWorkspaceConfig('demo'),
      mcpServer: { enabled: true, serverName: 'my-corpus' },
    } as never);
    const cfg = loadMCPConfig(tmp);
    expect(cfg.mcp.enabled).toBe(true);
    expect(cfg.mcp.serverName).toBe('my-corpus');
    expect(cfg.paths.mcpAccessLog).toBe(v2Paths(tmp).mcpAccessLog);
  });

  it('rejects newer schema_version', async () => {
    await ensureV2Directories(tmp);
    const p = v2Paths(tmp);
    await fs.writeFile(p.config, JSON.stringify({ schema_version: 99 }));
    expect(() => loadMCPConfig(tmp)).toThrow(/schema_version/);
  });
});
