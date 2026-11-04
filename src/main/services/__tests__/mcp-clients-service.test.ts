import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { mcpClientsService, toManagerConfig } from '../mcp-clients-service.js';
import { WorkspaceConfigError } from '../../../../backend/core/workspace/config.js';

describe('toManagerConfig — WorkspaceMCPClient → MCPClientConfig', () => {
  it('maps a stdio client with args + env', () => {
    const out = toManagerConfig({
      name: 'fs',
      transport: 'stdio',
      command: '/usr/bin/python',
      args: ['-m', 'mcp.fs'],
      env: { FOO: 'bar' },
    });
    expect(out).toEqual({
      name: 'fs',
      config: {
        transport: 'stdio',
        command: '/usr/bin/python',
        args: ['-m', 'mcp.fs'],
        env: { FOO: 'bar' },
      },
    });
  });

  it('maps a minimal stdio client (no args, no env)', () => {
    const out = toManagerConfig({
      name: 'bare',
      transport: 'stdio',
      command: 'cliodeck-mcp',
    });
    expect(out.config.transport).toBe('stdio');
    expect((out.config as { command: string }).command).toBe('cliodeck-mcp');
  });

  it('maps an sse client', () => {
    const out = toManagerConfig({
      name: 'remote',
      transport: 'sse',
      url: 'https://example.com/mcp/sse',
    });
    expect(out).toEqual({
      name: 'remote',
      config: { transport: 'sse', url: 'https://example.com/mcp/sse' },
    });
  });

  it('throws when stdio config has no command', () => {
    expect(() =>
      toManagerConfig({ name: 'broken', transport: 'stdio' })
    ).toThrowError(/requires a command/);
  });

  it('throws when sse config has no url', () => {
    expect(() =>
      toManagerConfig({ name: 'broken', transport: 'sse' })
    ).toThrowError(/requires a url/);
  });
});

/**
 * `config.json` illisible : le service ne le réécrit pas, ne lance rien, et ne fait pas échouer
 * l'ouverture du projet. Un commande inexistante : `start` échoue vite, sans réseau.
 */
describe('un config.json illisible n’est pas une configuration vide (S11-1-8)', () => {
  const CLIENT = { name: 'absent', transport: 'stdio' as const, command: '/nonexistent/cliodeck-mcp-test' };
  const VALID = JSON.stringify(
    {
      schema_version: 2,
      name: 'Thèse',
      vault: { path: '/Volumes/Notes' },
      mcpServer: { enabled: true },
      mcpClients: [{ name: 'europeana', transport: 'sse', url: 'http://127.0.0.1:9/sse' }],
    },
    null,
    2
  );
  const originalGate = mcpClientsService.approvalGate;

  let root: string;
  let configFile: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-'));
    mkdirSync(path.join(root, '.cliodeck'), { recursive: true });
    configFile = path.join(root, '.cliodeck', 'config.json');
    // Le service se charge sur un projet sain, avant d'être éprouvé : rien à démarrer.
    mcpClientsService.approvalGate = async () => 'rejected';
  });

  afterEach(async () => {
    mcpClientsService.approvalGate = originalGate;
    await mcpClientsService.unload();
    await rm(root, { recursive: true, force: true });
  });

  const BROKEN: Array<[string, string, string]> = [
    ['virgule en trop', `${VALID.slice(0, -2)},\n}`, 'invalid_json'],
    ['format plus récent', VALID.replace('"schema_version": 2', '"schema_version": 3'), 'newer_schema'],
  ];

  it.each(BROKEN)('%s : removeClient rejette, coffre et serveurs restent sur le disque', async (_label, content, kind) => {
    writeFileSync(configFile, VALID);
    await mcpClientsService.loadProject(root);
    writeFileSync(configFile, content);

    await expect(mcpClientsService.removeClient('europeana')).rejects.toMatchObject({ kind });

    expect(readFileSync(configFile, 'utf8')).toBe(content);
  });

  it.each(BROKEN)('%s : addClient rejette, sans démarrer ni écrire', async (_label, content, kind) => {
    writeFileSync(configFile, VALID);
    await mcpClientsService.loadProject(root);
    writeFileSync(configFile, content);

    await expect(mcpClientsService.addClient({ ...CLIENT })).rejects.toBeInstanceOf(WorkspaceConfigError);
    await expect(mcpClientsService.addClient({ ...CLIENT })).rejects.toMatchObject({ kind });

    expect(readFileSync(configFile, 'utf8')).toBe(content);
    expect(mcpClientsService.list()).toEqual([]);
  });

  it.each(BROKEN)('%s : loadProject ne rejette pas, ne lance rien, et le service reste propre', async (_label, content, kind) => {
    writeFileSync(configFile, content);
    let asked = 0;
    mcpClientsService.approvalGate = async () => {
      asked += 1;
      return 'approved';
    };

    await expect(mcpClientsService.loadProject(root)).resolves.toBeUndefined();

    expect(asked).toBe(0);
    expect(mcpClientsService.list()).toEqual([]);
    expect(readFileSync(configFile, 'utf8')).toBe(content);
    // Le projet reste ouvert : l'ajout suivant dit pourquoi, et une fois le fichier réparé tout repart.
    await expect(mcpClientsService.addClient({ ...CLIENT })).rejects.toMatchObject({ kind });
    writeFileSync(configFile, VALID);
    await mcpClientsService.removeClient('europeana');
    expect(JSON.parse(readFileSync(configFile, 'utf8')).mcpClients).toEqual([]);
    expect(JSON.parse(readFileSync(configFile, 'utf8')).vault).toEqual({ path: '/Volumes/Notes' });
  });

  it('le dossier du projet a disparu : loadProject ne rejette pas, ne recrée rien, ne lance rien', async () => {
    const gone = path.join(root, 'parent-renomme', 'These');
    let asked = 0;
    mcpClientsService.approvalGate = async () => {
      asked += 1;
      return 'approved';
    };

    await expect(mcpClientsService.loadProject(gone)).resolves.toBeUndefined();

    expect(asked).toBe(0);
    expect(existsSync(path.join(root, 'parent-renomme'))).toBe(false);
    await expect(mcpClientsService.addClient({ ...CLIENT })).rejects.toMatchObject({ kind: 'unreadable' });
    expect(existsSync(path.join(root, 'parent-renomme'))).toBe(false);
  });

  it('removeClient garde ce qu’a posé une écriture d’à côté, faite pendant qu’il tournait', async () => {
    writeFileSync(configFile, VALID);
    await mcpClientsService.loadProject(root);

    const { updateWorkspaceConfig } = await import('../../../../backend/core/workspace/config.js');
    await Promise.all([
      mcpClientsService.removeClient('europeana'),
      updateWorkspaceConfig(root, (cfg) => {
        cfg.security = { sourceInspectorMode: 'block' };
      }),
    ]);

    const disk = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    expect(disk.mcpClients).toEqual([]);
    expect(disk.security).toEqual({ sourceInspectorMode: 'block' });
    expect(disk.vault).toEqual({ path: '/Volumes/Notes' });
  });

  it('config.json absent : loadProject le crée, comme avant', async () => {
    await mcpClientsService.loadProject(root);
    expect(existsSync(configFile)).toBe(true);
    expect(JSON.parse(readFileSync(configFile, 'utf8')).name).toBe(path.basename(root));
  });

  it('aucun secret à ranger : ouvrir un projet ne réécrit pas config.json', async () => {
    writeFileSync(configFile, VALID);
    await mcpClientsService.loadProject(root);
    expect(readFileSync(configFile, 'utf8')).toBe(VALID);
  });
});
