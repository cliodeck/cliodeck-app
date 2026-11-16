/**
 * Vraie fabrique SDK, vrai processus : une app lancée depuis le Dock ou le Finder reçoit le PATH
 * de launchd, sans Homebrew ni les gestionnaires de l'utilisateur. Un serveur lancé par une
 * commande nue (`npx`, `node`, `uvx`) passait en `failed` sur « spawn … ENOENT » (S09-1-10).
 *
 * La commande vit dans le `~/.local/bin` d'un HOME temporaire (là où l'installeur de uv range
 * `uvx`) : le test ne dépend pas de ce qui est installé sur la machine.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http, { type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realMCPClientFactory } from '../sdk-factory.js';
import { MCPClientManager, type MCPClientHandle } from '../manager.js';
import type { MCPClientError, MCPClientEvent } from '../types.js';

const SERVER = fileURLToPath(new URL('./fixtures/mini-mcp-server.mjs', import.meta.url));
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

describe.skipIf(process.platform === 'win32')('realMCPClientFactory : PATH de launchd', () => {
  let home: string;
  let pidLog: string;
  let handle: MCPClientHandle | null;

  const pids = (): number[] =>
    existsSync(pidLog) ? readFileSync(pidLog, 'utf8').split('\n').filter(Boolean).map(Number) : [];

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-home-'));
    pidLog = path.join(home, 'pids.txt');
    const bin = path.join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    // Le mini-serveur, lancé par le chemin absolu de ce Node-ci : seule la commande se cherche.
    const fakecmd = path.join(bin, 'fakecmd');
    writeFileSync(fakecmd, `#!/bin/sh\nexec '${process.execPath}' '${SERVER}' "$@"\n`);
    chmodSync(fakecmd, 0o755);
    handle = null;
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', LAUNCHD_PATH);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await handle?.close();
    // Filet, par PID et jamais par motif.
    for (const pid of pids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // déjà parti
      }
    }
    await rm(home, { recursive: true, force: true });
  });

  it('trouve une commande nue de ~/.local/bin : connexion, catalogue, appel d’outil', async () => {
    handle = realMCPClientFactory({
      name: 'mini',
      config: { transport: 'stdio', command: 'fakecmd', args: [pidLog] },
    });

    await handle.connect();

    expect((await handle.listTools()).map((t) => t.name)).toEqual(['echo']);
    const call = await handle.callTool('echo', { texte: 'Dreyfus' });
    expect(call.ok).toBe(true);
    expect(call.result).toMatchObject({ content: [{ type: 'text', text: '{"texte":"Dreyfus"}' }] });
  }, 15_000);
});

/**
 * Une ligne de la sortie standard qui n'est pas du JSON-RPC (bannière, print de débogage) : le
 * transport du SDK l'écarte et continue de lire, mais la fabrique la prenait pour un plantage. Le
 * serveur était abattu et relancé, puis laissé en `failed` s'il écrivait sa bannière à chaque
 * lancement (S09-2-0). Et un catalogue paginé n'était lu que jusqu'à sa première page (S09-2-5).
 */
describe('realMCPClientFactory : sortie standard et catalogue paginé', () => {
  let dir: string;
  let pidLog: string;
  let handle: MCPClientHandle | null;
  let manager: MCPClientManager | null;
  let warn: MockInstance<typeof console.warn>;

  const pids = (): number[] =>
    existsSync(pidLog) ? readFileSync(pidLog, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  const serverConfig = (name: string, options: string[]) => ({
    name,
    config: { transport: 'stdio' as const, command: process.execPath, args: [SERVER, pidLog, ...options] },
  });
  const open = (name: string, ...options: string[]): MCPClientHandle =>
    realMCPClientFactory(serverConfig(name, options));
  const catalogue = (n: number): string[] => ['echo', ...Array.from({ length: n - 1 }, (_, i) => `outil-${i + 1}`)];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-stdout-'));
    pidLog = path.join(dir, 'pids.txt');
    handle = null;
    manager = null;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warn.mockRestore();
    await manager?.stopAll();
    await handle?.close();
    // Filet, par PID et jamais par motif.
    for (const pid of pids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // déjà parti
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('une bannière au lancement : la connexion s’établit, aucun plantage signalé', async () => {
    handle = open('bavard', '--banniere');
    const crashes: MCPClientError[] = [];
    handle.onCrash((err) => crashes.push(err));

    await handle.connect();

    expect((await handle.listTools()).map((t) => t.name)).toEqual(['echo']);
    expect(crashes).toEqual([]);
  }, 15_000);

  it('une ligne avant chaque appel d’outil : trois appels réussis, un seul processus ; tué, le serveur est un plantage', async () => {
    const events: MCPClientEvent[] = [];
    // Reprise lointaine : un plantage se lit dans l'état, sans qu'un second processus vienne brouiller le compte.
    manager = new MCPClientManager({ factory: realMCPClientFactory, retryDelayMs: 60_000, onEvent: (e) => events.push(e) });
    // Le bruit (une ligne de texte, une ligne JSON qui n'est pas du JSON-RPC) et la réponse partent dans
    // la même écriture : une ligne écartée ne mange pas la suivante.
    manager.register(serverConfig('bavard', ['--bruit-avant-appel']));
    const errorCodes = (): string[] => events.flatMap((e) => (e.kind === 'error' ? [e.error.code] : []));

    expect((await manager.start('bavard')).state).toBe('ready');
    for (const texte of ['Dreyfus', 'Zola', 'Picquart']) {
      const call = await manager.callTool('bavard', 'echo', { texte });
      expect(call.ok).toBe(true);
      expect(call.result).toMatchObject({ content: [{ type: 'text', text: JSON.stringify({ texte }) }] });
    }
    expect(manager.get('bavard')?.state).toBe('ready');
    expect(pids()).toHaveLength(1);
    expect(errorCodes()).toEqual([]);

    process.kill(pids()[0], 'SIGKILL');

    await vi.waitFor(() => expect(manager?.get('bavard')?.state).toBe('degraded'), { timeout: 10_000 });
    expect(errorCodes()).toEqual(['transport_closed']);
  }, 20_000);

  it('l’avertissement nomme le client, reste court, ne recopie pas la ligne, et se tait après cinq', async () => {
    const key = `sk-${'A1b2C3d4'.repeat(25)}`;
    handle = open(
      'bavard',
      `--banniere=OPENAI_API_KEY=${key}`,
      // Du JSON qui n'est pas du JSON-RPC : l'erreur de schéma du SDK fait plusieurs Ko.
      `--banniere=${JSON.stringify({ env: { OPENAI_API_KEY: key } })}`,
      ...Array.from({ length: 6 }, (_, i) => `--banniere=ligne ${i + 1}`)
    );
    const crashes: MCPClientError[] = [];
    handle.onCrash((err) => crashes.push(err));

    await handle.connect();
    await handle.listTools();

    expect(crashes).toEqual([]);
    // Huit lignes écartées : cinq signalées, puis une seule qui dit que les suivantes sont tues.
    const lines = warnings(warn);
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line.startsWith('[mcp-clients] bavard')).toBe(true);
      expect(line).not.toContain(key);
      expect(line.length).toBeLessThan(200);
    }
  }, 15_000);

  it('120 outils par pages de 50 : les 120 sont exposés', async () => {
    handle = open('catalogue', '--outils=120', '--page=50');
    await handle.connect();

    expect((await handle.listTools()).map((t) => t.name)).toEqual(catalogue(120));
  }, 15_000);

  it('un curseur qui revient sur une page déjà lue : la lecture s’arrête, les pages lues restent', async () => {
    handle = open('catalogue', '--outils=120', '--page=50', '--curseur=boucle');
    await handle.connect();

    expect((await handle.listTools()).map((t) => t.name)).toEqual(catalogue(120));
    // Arrêt sur le curseur répété, pas au plafond des pages : chaque page peut prendre une minute.
    expect(warnings(warn)).toHaveLength(1);
    expect(warnings(warn)[0].startsWith('[mcp-clients] catalogue')).toBe(true);
    expect(warnings(warn)[0]).toContain('déjà lu');
  }, 15_000);

  it('des pages sans fin : la lecture s’arrête au plafond, un outil vu deux fois garde sa première page', async () => {
    // Des curseurs toujours nouveaux, un catalogue de 30 outils repris en boucle par pages de 7.
    handle = open('catalogue', '--outils=30', '--page=7', '--curseur=sans-fin');
    await handle.connect();

    const tools = await handle.listTools();

    expect(tools.map((t) => t.name)).toEqual(catalogue(30));
    expect(tools.find((t) => t.name === 'outil-1')?.description).toBe('outil 1, page 0');
    expect(warnings(warn)).toHaveLength(1);
    expect(warnings(warn)[0].startsWith('[mcp-clients] catalogue')).toBe(true);
    expect(warnings(warn)[0]).toContain('pages');
  }, 15_000);

  // Le SDK vide son cache d'outils à chaque page de tools/list, puis le remplit avec cette seule page.
  // Un outil d'une page antérieure perdait le contrôle de son outputSchema (et la garde des outils
  // « task required ») : même outil, même serveur, contrôlé ou non selon la page où il tombait.
  it.each<[string, string[]]>([
    ['sur une seule page', []],
    ['en première page de deux', ['--outils=2', '--page=1']],
    ['en première page, puis revu sans schéma', ['--outils=30', '--page=7', '--curseur=sans-fin']],
  ])('un outil à outputSchema %s : un appel sans sortie structurée est refusé', async (_cas, options) => {
    handle = open('catalogue', '--schema-sortie', ...options);
    await handle.connect();
    expect((await handle.listTools()).map((t) => t.name)).toContain('echo');

    const call = await handle.callTool('echo', { texte: 'Dreyfus' });

    expect(call.ok).toBe(false);
    expect(call.error?.message).toContain('has an output schema but did not return structured content');
  }, 15_000);

  it('un outil répété, que seule une page suivante dote d’un outputSchema : le contrôle suit l’entrée exposée, la première', async () => {
    // `echo` revient aux pages 0, 4, 8, 12 et 17 ; seule la page 4 lui donne un outputSchema.
    handle = open('catalogue', '--schema-sortie=4', '--outils=30', '--page=7', '--curseur=sans-fin');
    await handle.connect();
    await handle.listTools();

    const call = await handle.callTool('echo', { texte: 'Dreyfus' });

    expect(call.error).toBeUndefined();
    expect(call.ok).toBe(true);
  }, 15_000);

  it('arrêté pendant la lecture du catalogue : le client s’arrête sans attendre la page en cours', async () => {
    manager = new MCPClientManager({ factory: realMCPClientFactory });
    // Chaque page met une minute à venir : sans sortie, `handshaking` durerait jusqu'au plafond.
    manager.register(serverConfig('lent', ['--outils=30', '--page=7', '--curseur=sans-fin', '--lent=60000']));
    const started = manager.start('lent');
    await vi.waitFor(() => expect(manager?.get('lent')?.state).toBe('handshaking'), { timeout: 10_000 });

    await manager.stop('lent');

    expect((await started).state).toBe('stopped');
    const [pid] = pids();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 });
  }, 20_000);
});

/**
 * SSE : un événement qui n'est pas du JSON-RPC arrive lui aussi par `onerror`, et le transport
 * continue de lire. Une erreur du flux (`SseError`) reste un plantage. Serveur local, en mémoire.
 */
describe('realMCPClientFactory : SSE', () => {
  let server: http.Server;
  let stream: ServerResponse | null;
  let handle: MCPClientHandle | null;
  let warn: MockInstance<typeof console.warn>;

  const reply = (message: { id?: number; method?: string; params?: { protocolVersion?: string } }) => {
    if (message.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'mini-sse', version: '0.0.0' },
        },
      };
    }
    if (message.method === 'tools/list') {
      return { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } };
    }
    return null;
  };

  beforeEach(async () => {
    stream = null;
    handle = null;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/sse' && !stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('event: endpoint\ndata: /messages\n\n');
        res.write('event: message\ndata: Server starting...\n\n');
        stream = res;
        return;
      }
      if (req.method === 'POST' && req.url === '/messages') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        req.on('end', () => {
          res.writeHead(202).end();
          const answer = reply(JSON.parse(body));
          if (answer) stream?.write(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    warn.mockRestore();
    await handle?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('un événement mal formé n’est pas un plantage ; un flux coupé en est un', async () => {
    const { port } = server.address() as AddressInfo;
    handle = realMCPClientFactory({ name: 'distant', config: { transport: 'sse', url: `http://127.0.0.1:${port}/sse` } });
    const crashes: MCPClientError[] = [];
    handle.onCrash((err) => crashes.push(err));

    await handle.connect();

    expect((await handle.listTools()).map((t) => t.name)).toEqual(['echo']);
    expect(crashes).toEqual([]);
    expect(warnings(warn)).toHaveLength(1);

    stream?.destroy();

    await vi.waitFor(() => expect(crashes.map((c) => c.code)).toEqual(['transport_error']), { timeout: 10_000 });
  }, 20_000);
});

function warnings(spy: MockInstance<typeof console.warn>): string[] {
  return spy.mock.calls.map((args) => args.map(String).join(' '));
}
