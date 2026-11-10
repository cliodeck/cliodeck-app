import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { mcpClientsService, toManagerConfig } from '../mcp-clients-service.js';
import { WorkspaceConfigError } from '../../../../backend/core/workspace/config.js';
import { withFileLock } from '../../../../backend/core/fs/user-files.js';
import type { MCPClientEvent } from '../../../../backend/integrations/mcp-clients/types.js';
import { symlinkAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

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

/**
 * Vraie fabrique SDK et vrais processus : le transport stdio du SDK appelle onclose même pour une
 * fermeture voulue. « Supprimer » relançait le serveur 500 ms plus tard, de nouveau prêt, ses
 * outils offerts au modèle ; « Redémarrer » laissait deux processus (S09-1-0, S09-1-1).
 */
describe('vraie fabrique SDK et mini-serveur stdio : arrêté veut dire arrêté', () => {
  const SERVER = fileURLToPath(new URL('./fixtures/mini-mcp-server.mjs', import.meta.url));
  const originalGate = mcpClientsService.approvalGate;

  let root: string;
  let pidLog: string;
  let events: MCPClientEvent[];
  let unsubscribe: () => void;

  const pids = (): number[] =>
    existsSync(pidLog) ? readFileSync(pidLog, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const client = () => ({
    name: 'mini',
    transport: 'stdio' as const,
    command: process.execPath,
    args: [SERVER, pidLog],
  });
  const stateOf = (name: string) => mcpClientsService.list().find((c) => c.name === name)?.state;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-real-'));
    mkdirSync(path.join(root, '.cliodeck'), { recursive: true });
    writeFileSync(path.join(root, '.cliodeck', 'config.json'), JSON.stringify({ schema_version: 2, name: 'Thèse' }));
    pidLog = path.join(root, 'pids.txt');
    mcpClientsService.approvalGate = async () => 'approved';
    await mcpClientsService.loadProject(root);
    events = [];
    unsubscribe = mcpClientsService.subscribe((e) => events.push(e));
  });

  afterEach(async () => {
    unsubscribe();
    mcpClientsService.approvalGate = originalGate;
    await mcpClientsService.unload();
    // Filet, par PID et jamais par motif : sur le code fautif, un serveur relancé survivrait au test.
    for (const pid of pids()) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  });

  it('« Supprimer » : arrêté, toujours arrêté 2,5 s plus tard, et plus aucun processus', async () => {
    expect((await mcpClientsService.addClient(client())).state).toBe('ready');
    expect(pids()).toHaveLength(1);

    await mcpClientsService.removeClient('mini');
    const stoppedAt = events.length;
    expect(stateOf('mini')).toBe('stopped');

    // La reprise fantôme partait à 500 ms : on la laisse largement passer.
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(stateOf('mini')).toBe('stopped');
    expect(events.slice(stoppedAt)).toEqual([]);
    expect(pids()).toHaveLength(1);
    expect(pids().filter(alive)).toEqual([]);
  }, 15_000);

  it('« Redémarrer » : un seul processus vivant, et le nouveau', async () => {
    await mcpClientsService.addClient(client());

    expect((await mcpClientsService.restart('mini'))?.state).toBe('ready');
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(stateOf('mini')).toBe('ready');
    expect(pids()).toHaveLength(2);
    expect(pids().filter(alive)).toEqual([pids()[1]]);
  }, 15_000);

  it('unload : aucun processus ne survit au projet', async () => {
    await mcpClientsService.addClient(client());

    await mcpClientsService.unload();
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(pids()).toHaveLength(1);
    expect(pids().filter(alive)).toEqual([]);
  }, 15_000);
});

/**
 * Un autre projet ouvert pendant une opération : le service relisait `this.manager` et
 * `this.workspaceRoot` après ses attentes, et finissait l'opération dans le projet suivant (S09-1-19).
 */
describe('un autre projet ouvert pendant une opération MCP (S09-1-19)', () => {
  const originalGate = mcpClientsService.approvalGate;
  // Commande absente : si elle était lancée, elle échouerait vite, sans réseau.
  const CLIENT = { name: 'fantome', transport: 'stdio' as const, command: '/nonexistent/cliodeck-mcp-test' };
  const config = (clients: unknown[]) => JSON.stringify({ schema_version: 2, name: 'p', mcpClients: clients }, null, 2);

  let rootA: string;
  let rootB: string;
  let configA: string;
  let configB: string;

  beforeEach(async () => {
    rootA = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-A-'));
    rootB = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-B-'));
    for (const root of [rootA, rootB]) mkdirSync(path.join(root, '.cliodeck'), { recursive: true });
    configA = path.join(rootA, '.cliodeck', 'config.json');
    configB = path.join(rootB, '.cliodeck', 'config.json');
    writeFileSync(configA, config([{ name: 'europeana', transport: 'sse', url: 'http://127.0.0.1:9/sse' }]));
    writeFileSync(configB, config([]));
    // Rien ne démarre au chargement : ces tests portent sur les opérations, pas sur le garde.
    mcpClientsService.approvalGate = async () => 'rejected';
    await mcpClientsService.loadProject(rootA);
  });

  afterEach(async () => {
    mcpClientsService.approvalGate = originalGate;
    await mcpClientsService.unload();
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  });

  /** Retient le config.json de A sous son verrou pendant qu'on ouvre B, puis le relâche. */
  async function switchToBWhileHoldingA<T>(operation: () => Promise<T>): Promise<PromiseSettledResult<T>> {
    let release!: () => void;
    const held = withFileLock(configA, () => new Promise<void>((resolve) => (release = resolve)));
    const pending = operation();
    await mcpClientsService.loadProject(rootB);
    release();
    await held;
    const [settled] = await Promise.allSettled([pending]);
    return settled;
  }

  it('addClient : refusé (project-changed), rien d’écrit ni de démarré, ni dans A ni dans B', async () => {
    const beforeA = readFileSync(configA, 'utf8');
    const beforeB = readFileSync(configB, 'utf8');

    const settled = await switchToBWhileHoldingA(() => mcpClientsService.addClient({ ...CLIENT }));

    expect(settled.status).toBe('rejected');
    expect(settled.status === 'rejected' && (settled.reason as Error).message).toBe('project-changed');
    expect(mcpClientsService.list()).toEqual([]);
    expect(readFileSync(configB, 'utf8')).toBe(beforeB);
    expect(readFileSync(configA, 'utf8')).toBe(beforeA);
  });

  it('addClient : B ouvert une fois l’ajout écrit dans A — pas de refus, rien de démarré', async () => {
    const beforeB = readFileSync(configB, 'utf8');
    const events: MCPClientEvent[] = [];
    const unsubscribe = mcpClientsService.subscribe((e) => events.push(e));
    // Le mutateur lit `env` (migration des secrets) après sa garde : B s'ouvre là, juste avant
    // l'écriture du config.json de A. Non énumérable, la propriété n'est pas écrite.
    let loadingB: Promise<void> | null = null;
    const client = { ...CLIENT };
    Object.defineProperty(client, 'env', {
      enumerable: false,
      get() {
        loadingB ??= mcpClientsService.loadProject(rootB);
        return undefined;
      },
    });

    try {
      const instance = await mcpClientsService.addClient(client);
      await loadingB;

      // Le serveur EST inscrit dans A : dire « rien n'y a été écrit » serait faux.
      expect(loadingB).not.toBeNull();
      expect(instance).toMatchObject({ name: 'fantome', state: 'unconfigured' });
      expect(JSON.parse(readFileSync(configA, 'utf8')).mcpClients).toContainEqual(CLIENT);
      // Rien n'est démarré, ni dans le manager abandonné ni dans celui de B.
      expect(events.filter((e) => e.name === 'fantome')).toEqual([]);
      expect(mcpClientsService.list()).toEqual([]);
      expect(readFileSync(configB, 'utf8')).toBe(beforeB);
    } finally {
      unsubscribe();
    }
  });

  it('removeClient : refusé (project-changed), le serveur reste dans le config.json de A', async () => {
    const beforeA = readFileSync(configA, 'utf8');

    const settled = await switchToBWhileHoldingA(() => mcpClientsService.removeClient('europeana'));

    expect(settled.status).toBe('rejected');
    expect(settled.status === 'rejected' && (settled.reason as Error).message).toBe('project-changed');
    expect(readFileSync(configA, 'utf8')).toBe(beforeA);
  });

  it('restart : un autre projet ouvert pendant l’arrêt, rien n’est relancé (project-changed)', async () => {
    const pending = mcpClientsService.restart('europeana');
    const loadingB = mcpClientsService.loadProject(rootB);

    await expect(pending).rejects.toThrow('project-changed');
    await loadingB;
    expect(mcpClientsService.list()).toEqual([]);
  });
});

/**
 * D18 : `.cliodeck` lié hors du projet. Charger le projet créait `recipes/`, `recipes-runs/` et le
 * journal d'accès MCP à l'autre bout du lien, avant même de lire la configuration.
 */
describe.skipIf(!symlinkAvailable)('loadProject : .cliodeck lié hors du projet', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-'));
    outside = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-ailleurs-'));
  });

  afterEach(async () => {
    await mcpClientsService.unload();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('rien n’est créé à l’autre bout, aucun serveur ne démarre', async () => {
    writeFileSync(
      path.join(outside, 'config.json'),
      JSON.stringify({ schema_version: 2, name: 'Autre', mcpClients: [{ name: 'x', transport: 'sse', url: 'http://127.0.0.1:9/sse' }] })
    );
    symlinkSync(outside, path.join(root, '.cliodeck'));

    await expect(mcpClientsService.loadProject(root)).resolves.toBeUndefined();

    expect(readdirSync(outside)).toEqual(['config.json']);
    expect(mcpClientsService.list()).toEqual([]);
  });
});
