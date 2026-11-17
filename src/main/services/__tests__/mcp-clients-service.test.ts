import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// `secureStorage` repose sur `safeStorage` d'Electron : une table en mémoire le remplace, comme
// dans mcp-env-secrets.test.ts.
const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('../secure-storage.js', () => ({
  secureStorage: {
    setKey: (k: string, v: string) => void (v ? secrets.set(k, v) : secrets.delete(k)),
    getKey: (k: string) => secrets.get(k) ?? '',
    deleteKey: (k: string) => void secrets.delete(k),
    hasKey: (k: string) => secrets.has(k),
  },
}));

import { mcpClientsService, toManagerConfig } from '../mcp-clients-service.js';
import { SECRET_SENTINEL } from '../mcp-env-secrets.js';
import { fingerprintClient } from '../mcp-approval-registry.js';
import { WorkspaceConfigError, type MCPClientConfig } from '../../../../backend/core/workspace/config.js';
import { withFileLock } from '../../../../backend/core/fs/user-files.js';
import { MCPClientManager } from '../../../../backend/integrations/mcp-clients/manager.js';
import type { MCPClientConfig as ManagerClientConfig, MCPClientEvent } from '../../../../backend/integrations/mcp-clients/types.js';
import { symlinkAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

describe('toManagerConfig — WorkspaceMCPClient → MCPClientConfig', () => {
  it('maps a stdio client with args + env', () => {
    const out = toManagerConfig(
      {
        name: 'fs',
        transport: 'stdio',
        command: '/usr/bin/python',
        args: ['-m', 'mcp.fs'],
        env: { FOO: 'bar' },
      },
      null
    );
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
    const out = toManagerConfig({ name: 'bare', transport: 'stdio', command: 'cliodeck-mcp' }, null);
    expect(out.config.transport).toBe('stdio');
    expect((out.config as { command: string }).command).toBe('cliodeck-mcp');
  });

  it('maps an sse client', () => {
    const out = toManagerConfig({ name: 'remote', transport: 'sse', url: 'https://example.com/mcp/sse' }, null);
    expect(out).toEqual({
      name: 'remote',
      config: { transport: 'sse', url: 'https://example.com/mcp/sse' },
    });
  });

  it('throws when stdio config has no command', () => {
    expect(() =>
      toManagerConfig({ name: 'broken', transport: 'stdio' }, null)
    ).toThrowError(/requires a command/);
  });

  it('throws when sse config has no url', () => {
    expect(() =>
      toManagerConfig({ name: 'broken', transport: 'sse' }, null)
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

  // A10 : `loadProject` passe à chaque ouverture de projet. Un projet sans serveur n'y gagne rien sur
  // le disque : ni config.json, ni journal d'accès vide, ni dossiers de recettes.
  it('config.json absent : loadProject ne crée rien dans .cliodeck, et un ajout le crée (A10)', async () => {
    await mcpClientsService.loadProject(root);

    expect(readdirSync(path.join(root, '.cliodeck'))).toEqual([]);
    // Le projet reste chargé : l'ajout écrit config.json, comme avant.
    await mcpClientsService.addClient({ ...CLIENT });
    expect(JSON.parse(readFileSync(configFile, 'utf8')).mcpClients).toEqual([CLIENT]);
  });

  it('config.json sans serveur : loadProject n’ajoute rien à .cliodeck (A10)', async () => {
    writeFileSync(configFile, JSON.stringify({ schema_version: 2, name: 'Thèse', mcpClients: [] }));

    await mcpClientsService.loadProject(root);

    expect(readdirSync(path.join(root, '.cliodeck'))).toEqual(['config.json']);
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
  const SERVER = fileURLToPath(
    new URL('../../../../backend/integrations/mcp-clients/__tests__/fixtures/mini-mcp-server.mjs', import.meta.url)
  );
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

  it('« Supprimer » : retiré, toujours absent 2,5 s plus tard, et plus aucun processus', async () => {
    expect((await mcpClientsService.addClient(client())).state).toBe('ready');
    expect(pids()).toHaveLength(1);

    await mcpClientsService.removeClient('mini');
    const stoppedAt = events.length;
    // Retiré, plus seulement arrêté : la liste ne le montre plus (S09-1-3).
    expect(stateOf('mini')).toBeUndefined();

    // La reprise fantôme partait à 500 ms : on la laisse largement passer.
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(stateOf('mini')).toBeUndefined();
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

/**
 * Contre-vérification de S09-1-6, sur le service réel : deux projets déclarent un client
 * `europeana`, chacun avec sa clé. Les secrets étaient rangés sous le seul nom du client, dans un
 * magasin commun : charger B écrasait la clé de A, et supprimer le client dans B l'effaçait. Le
 * démarrage est remplacé (aucun processus) ; l'env lu est celui que le manager reçoit, tel qu'il
 * irait au serveur.
 */
describe('clés des serveurs MCP : une portée par projet (S09-1-6)', () => {
  const originalGate = mcpClientsService.approvalGate;
  // La clé qu'ont écrite les versions d'avant, dans le magasin de l'utilisateur : son nom ne change pas.
  const LEGACY = 'mcp.client.europeana.env.EUROPEANA_API_KEY';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const europeana = (key: string): MCPClientConfig => ({
    name: 'europeana',
    transport: 'stdio',
    command: '/nonexistent/europeana-mcp',
    args: ['--lang', 'fr'],
    env: { EUROPEANA_API_KEY: key, EUROPEANA_LANG: 'fr' },
  });

  const roots: string[] = [];
  let registered: ManagerClientConfig[];
  let seenByGate: MCPClientConfig[];

  async function makeProject(clients: MCPClientConfig[]): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-cles-'));
    roots.push(root);
    mkdirSync(path.join(root, '.cliodeck'), { recursive: true });
    writeFileSync(configOf(root), JSON.stringify({ schema_version: 2, name: 'p', mcpClients: clients }, null, 2));
    return root;
  }
  const configOf = (root: string): string => path.join(root, '.cliodeck', 'config.json');
  const diskOf = (root: string): Record<string, unknown> & { mcpClients: MCPClientConfig[] } =>
    JSON.parse(readFileSync(configOf(root), 'utf8'));
  /** L'env que le manager a reçu pour `europeana` au dernier chargement. */
  const lastEnv = (): Record<string, string> | undefined => {
    const last = registered.filter((c) => c.name === 'europeana').at(-1);
    return last?.config.transport === 'stdio' ? last.config.env : undefined;
  };

  beforeEach(() => {
    secrets.clear();
    registered = [];
    seenByGate = [];
    mcpClientsService.approvalGate = async (client) => {
      seenByGate.push(structuredClone(client));
      return 'approved';
    };
    const register = MCPClientManager.prototype.register;
    vi.spyOn(MCPClientManager.prototype, 'register').mockImplementation(function (this: MCPClientManager, cfg) {
      registered.push(structuredClone(cfg));
      register.call(this, cfg);
    });
    vi.spyOn(MCPClientManager.prototype, 'startAll').mockResolvedValue([]);
    vi.spyOn(MCPClientManager.prototype, 'start').mockImplementation(async (name: string) => ({
      name,
      state: 'unconfigured',
      tools: [],
      generation: 0,
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    mcpClientsService.approvalGate = originalGate;
    await mcpClientsService.unload();
    for (const root of roots.splice(0)) {
      if (existsSync(configOf(root))) chmodSync(configOf(root), 0o644);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('A puis B, client retiré dans B, A rechargé : le serveur de A reçoit toujours sa clé', async () => {
    const rootA = await makeProject([europeana('cle-test-A')]);
    const rootB = await makeProject([europeana('cle-test-B')]);

    await mcpClientsService.loadProject(rootA);
    expect(lastEnv()).toEqual({ EUROPEANA_API_KEY: 'cle-test-A', EUROPEANA_LANG: 'fr' });
    await mcpClientsService.loadProject(rootB);
    expect(lastEnv()).toEqual({ EUROPEANA_API_KEY: 'cle-test-B', EUROPEANA_LANG: 'fr' });
    await mcpClientsService.removeClient('europeana');

    await mcpClientsService.loadProject(rootA);

    expect(lastEnv()).toEqual({ EUROPEANA_API_KEY: 'cle-test-A', EUROPEANA_LANG: 'fr' });
    // Sur le disque, la sentinelle seule, et une portée différente pour chaque projet.
    expect(diskOf(rootA).mcpClients[0].env).toEqual({ EUROPEANA_API_KEY: SECRET_SENTINEL, EUROPEANA_LANG: 'fr' });
    expect(diskOf(rootA).secrets_scope).toMatch(UUID);
    expect(diskOf(rootB).secrets_scope).toMatch(UUID);
    expect(diskOf(rootA).secrets_scope).not.toBe(diskOf(rootB).secrets_scope);
    expect([...secrets.values()]).not.toContain('cle-test-B');
  });

  it('projet déjà migré, sans portée : portée créée au chargement, ancienne clé recopiée et gardée, même empreinte', async () => {
    secrets.set(LEGACY, 'cle-test-A');
    const migrated = europeana(SECRET_SENTINEL);
    const rootA = await makeProject([migrated]);
    const approvedBefore = fingerprintClient(migrated);

    await mcpClientsService.loadProject(rootA);

    const scope = diskOf(rootA).secrets_scope;
    expect(scope).toMatch(UUID);
    expect(lastEnv()).toEqual({ EUROPEANA_API_KEY: 'cle-test-A', EUROPEANA_LANG: 'fr' });
    expect(secrets.get(`mcp.project.${scope}.client.europeana.env.EUROPEANA_API_KEY`)).toBe('cle-test-A');
    // Un accord donné avant ce correctif vaut toujours : ni la portée ni la clé n'entrent dans l'env.
    expect(diskOf(rootA).mcpClients[0]).toEqual(migrated);
    expect(seenByGate.map(fingerprintClient)).toEqual([approvedBefore]);
  });

  it('retirer le client d’un projet ancien n’efface pas l’ancienne clé, dont un autre projet dépend', async () => {
    secrets.set(LEGACY, 'cle-test-A');
    const rootA = await makeProject([europeana(SECRET_SENTINEL)]);
    const rootC = await makeProject([europeana(SECRET_SENTINEL)]);

    await mcpClientsService.loadProject(rootA);
    await mcpClientsService.removeClient('europeana');

    expect(secrets.get(LEGACY)).toBe('cle-test-A');
    // C, pas encore rouvert depuis le correctif, la retrouve.
    await mcpClientsService.loadProject(rootC);
    expect(lastEnv()).toEqual({ EUROPEANA_API_KEY: 'cle-test-A', EUROPEANA_LANG: 'fr' });
  });

  it('rechargé, le même projet garde sa portée et son empreinte', async () => {
    const rootA = await makeProject([europeana('cle-test-A')]);
    await mcpClientsService.loadProject(rootA);
    const scope = diskOf(rootA).secrets_scope;
    const written = readFileSync(configOf(rootA), 'utf8');

    await mcpClientsService.loadProject(rootA);

    expect(readFileSync(configOf(rootA), 'utf8')).toBe(written);
    expect(diskOf(rootA).secrets_scope).toBe(scope);
    expect(seenByGate.map(fingerprintClient)).toEqual([fingerprintClient(seenByGate[0]), fingerprintClient(seenByGate[0])]);
    expect(lastEnv()).toEqual({ EUROPEANA_API_KEY: 'cle-test-A', EUROPEANA_LANG: 'fr' });
  });

  it.skipIf(process.getuid?.() === 0)(
    'config.json qui ne s’écrit pas : pas de portée, et l’ancienne clé sert toujours',
    async () => {
      secrets.set(LEGACY, 'cle-test-A');
      const rootA = await makeProject([europeana(SECRET_SENTINEL)]);
      const before = readFileSync(configOf(rootA), 'utf8');
      chmodSync(configOf(rootA), 0o444);

      await mcpClientsService.loadProject(rootA);

      expect(readFileSync(configOf(rootA), 'utf8')).toBe(before);
      expect(lastEnv()).toEqual({ EUROPEANA_API_KEY: 'cle-test-A', EUROPEANA_LANG: 'fr' });
      expect([...secrets.keys()]).toEqual([LEGACY]);
    }
  );

  it.skipIf(process.getuid?.() === 0)(
    'config.json qui ne s’écrit pas, clé en clair : rien ne reste rangé sous une portée qui n’a pas pu s’écrire',
    async () => {
      const rootA = await makeProject([europeana('cle-test-A')]);
      const before = readFileSync(configOf(rootA), 'utf8');
      chmodSync(configOf(rootA), 0o444);

      await mcpClientsService.loadProject(rootA);
      await mcpClientsService.loadProject(rootA);

      // La clé est restée en clair dans config.json, et le serveur la reçoit à chaque chargement.
      expect(readFileSync(configOf(rootA), 'utf8')).toBe(before);
      expect(registered.filter((c) => c.name === 'europeana')).toHaveLength(2);
      expect(lastEnv()).toEqual({ EUROPEANA_API_KEY: 'cle-test-A', EUROPEANA_LANG: 'fr' });
      // Aucune copie orpheline, une de plus à chaque ouverture.
      expect([...secrets.keys()]).toEqual([]);
    }
  );

  it.skipIf(process.getuid?.() === 0)(
    'addClient dont l’écriture échoue : la clé ne reste pas sous une portée inconnue de config.json',
    async () => {
      const rootA = await makeProject([]);
      await mcpClientsService.loadProject(rootA);
      const before = readFileSync(configOf(rootA), 'utf8');
      chmodSync(configOf(rootA), 0o444);

      await expect(mcpClientsService.addClient(europeana('cle-test-A'))).rejects.toMatchObject({ code: 'EACCES' });

      expect(readFileSync(configOf(rootA), 'utf8')).toBe(before);
      expect([...secrets.keys()]).toEqual([]);
    }
  );

  /**
   * Projet qui a déjà sa portée (L08-8, revue) : `discardUnsavedScope` ne vaut que pour une portée née
   * dans l'écriture, et la clé rangée sous une portée enregistrée restait dans le coffre, sans entrée
   * dans config.json. Le client `europeana`, déclaré, a la sienne, qui doit rester.
   */
  describe('ajout qui n’est pas écrit, sur un projet qui a déjà sa portée', () => {
    const SCOPE = '11111111-2222-3333-4444-555555555555';
    const EUROPEANA_KEY = `mcp.project.${SCOPE}.client.europeana.env.EUROPEANA_API_KEY`;

    async function projectWithScope(): Promise<string> {
      const root = await makeProject([]);
      writeFileSync(
        configOf(root),
        JSON.stringify(
          { schema_version: 2, name: 'p', secrets_scope: SCOPE, mcpClients: [europeana(SECRET_SENTINEL)] },
          null,
          2
        )
      );
      secrets.set(EUROPEANA_KEY, 'cle-test-A');
      await mcpClientsService.loadProject(root);
      return root;
    }

    it.skipIf(process.getuid?.() === 0)(
      'écriture qui échoue : la clé rangée par cette tentative est retirée, celle du client déclaré reste',
      async () => {
        const rootA = await projectWithScope();
        const before = readFileSync(configOf(rootA), 'utf8');
        chmodSync(configOf(rootA), 0o444);

        await expect(
          mcpClientsService.addClient({
            name: 'gallica',
            transport: 'stdio',
            command: '/nonexistent/gallica-mcp',
            env: { GALLICA_API_KEY: 'cle-test-G' },
          })
        ).rejects.toMatchObject({ code: 'EACCES' });

        expect(readFileSync(configOf(rootA), 'utf8')).toBe(before);
        expect([...secrets.entries()]).toEqual([[EUROPEANA_KEY, 'cle-test-A']]);
      }
    );

    it('stdio sans commande : refusé, aucune clé gardée sous la portée du projet', async () => {
      const rootA = await projectWithScope();
      const before = readFileSync(configOf(rootA), 'utf8');

      await expect(
        mcpClientsService.addClient({ name: 'gallica', transport: 'stdio', env: { GALLICA_API_KEY: 'cle-test-G' } })
      ).rejects.toThrow(/requires a command/);

      expect(readFileSync(configOf(rootA), 'utf8')).toBe(before);
      expect([...secrets.entries()]).toEqual([[EUROPEANA_KEY, 'cle-test-A']]);
    });

    it('nom déjà déclaré : refusé, la clé du client déclaré n’est ni remplacée ni retirée', async () => {
      await projectWithScope();

      await expect(mcpClientsService.addClient(europeana('autre-cle'))).rejects.toThrow(/already exists/);

      expect([...secrets.entries()]).toEqual([[EUROPEANA_KEY, 'cle-test-A']]);
    });
  });

  it('aucune clé déclarée : ni portée ni écriture', async () => {
    const rootA = await makeProject([{ name: 'local', transport: 'stdio', command: '/nonexistent/x', env: { LANG: 'fr' } }]);
    const before = readFileSync(configOf(rootA), 'utf8');

    await mcpClientsService.loadProject(rootA);

    expect(readFileSync(configOf(rootA), 'utf8')).toBe(before);
  });

  it('addClient avec une clé : rangée sous la portée du projet, créée dans la même écriture', async () => {
    const rootA = await makeProject([]);
    await mcpClientsService.loadProject(rootA);

    await mcpClientsService.addClient(europeana('cle-test-A'));

    const scope = diskOf(rootA).secrets_scope;
    expect(scope).toMatch(UUID);
    expect(diskOf(rootA).mcpClients[0].env).toEqual({ EUROPEANA_API_KEY: SECRET_SENTINEL, EUROPEANA_LANG: 'fr' });
    expect([...secrets.entries()]).toEqual([[`mcp.project.${scope}.client.europeana.env.EUROPEANA_API_KEY`, 'cle-test-A']]);
    expect(lastEnv()).toEqual({ EUROPEANA_API_KEY: 'cle-test-A', EUROPEANA_LANG: 'fr' });
  });
});
