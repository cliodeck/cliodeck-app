import { describe, it, expect, vi, afterEach } from 'vitest';
import { MCPClientManager } from '../manager.js';
import type {
  MCPClientConfig,
  MCPClientEvent,
  MCPClientError,
  MCPToolDescriptor,
} from '../types.js';
import type { MCPClientHandle } from '../manager.js';

interface FakeOptions {
  tools?: MCPToolDescriptor[];
  connectThrows?: string;
  listToolsThrows?: string;
  callTool?: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ ok: boolean; result?: unknown; error?: MCPClientError }>;
  /** Comme le transport stdio du SDK : fermer le handle appelle son onclose, donc onCrash. */
  closeCrashes?: boolean;
  /** Un serveur qui ne ferme jamais : close() ne rend pas la main. */
  closeHangs?: boolean;
  /** Un serveur lent à fermer : close() rend la main après ce délai. */
  closeDelayMs?: number;
}

function makeFake(opts: FakeOptions = {}): {
  handle: MCPClientHandle;
  triggerCrash: (err: MCPClientError) => void;
  isClosed: () => boolean;
} {
  let crashCb: (err: MCPClientError) => void = () => undefined;
  // Comme `fireCrash` de la vraie fabrique : un handle ne signale sa mort qu'une fois.
  let crashed = false;
  const fireCrash = (err: MCPClientError): void => {
    if (crashed) return;
    crashed = true;
    crashCb(err);
  };
  let closed = false;
  const handle: MCPClientHandle = {
    async connect() {
      if (opts.connectThrows) throw new Error(opts.connectThrows);
    },
    async listTools() {
      if (opts.listToolsThrows) throw new Error(opts.listToolsThrows);
      return opts.tools ?? [];
    },
    async callTool(name, args) {
      if (opts.callTool) return opts.callTool(name, args);
      return { ok: true, result: { echoed: { name, args } } };
    },
    async close() {
      closed = true;
      if (opts.closeCrashes) {
        fireCrash({ code: 'transport_closed', message: 'stdio transport closed', at: 'close' });
      }
      if (opts.closeHangs) await new Promise<never>(() => undefined);
      if (opts.closeDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.closeDelayMs));
    },
    onCrash(cb) {
      crashCb = cb;
    },
  };
  return { handle, triggerCrash: fireCrash, isClosed: () => closed };
}

/** Fabrique qui garde chaque faux handle créé, pour compter les lancements et les handles ouverts. */
function recordingFactory(opts: FakeOptions | ((call: number) => FakeOptions) = {}) {
  const fakes: Array<ReturnType<typeof makeFake>> = [];
  const factory = (): MCPClientHandle => {
    const fake = makeFake(typeof opts === 'function' ? opts(fakes.length + 1) : opts);
    fakes.push(fake);
    return fake.handle;
  };
  const open = (): number => fakes.filter((f) => !f.isClosed()).length;
  return { factory, fakes, open };
}

const CRASH: MCPClientError = { code: 'subprocess_exit', message: 'exit 1', at: 't' };

const cfg = (name: string): MCPClientConfig => ({
  name,
  config: {
    transport: 'stdio',
    command: 'node',
    args: ['fake.js'],
  },
});

describe('MCPClientManager (4.4)', () => {
  it('starts a client through unconfigured → spawning → handshaking → ready', async () => {
    const events: MCPClientEvent[] = [];
    const tools: MCPToolDescriptor[] = [
      { name: 'search', description: 'demo', inputSchema: {} },
    ];
    const { handle } = makeFake({ tools });
    const mgr = new MCPClientManager({
      factory: () => handle,
      onEvent: (e) => events.push(e),
    });
    mgr.register(cfg('gallica'));
    const instance = await mgr.start('gallica');

    expect(instance.state).toBe('ready');
    expect(instance.tools).toEqual(tools);
    expect(instance.lastReadyAt).toBeDefined();
    expect(instance.lastError).toBeUndefined();

    const states = events
      .filter((e) => e.kind === 'state_changed')
      .map((e) =>
        e.kind === 'state_changed' ? [e.from, e.to] : ['?', '?']
      );
    expect(states).toEqual([
      ['unconfigured', 'spawning'],
      ['spawning', 'handshaking'],
      ['handshaking', 'ready'],
    ]);

    expect(events.some((e) => e.kind === 'tools_updated')).toBe(true);
  });

  it('transitions to failed on connect error and emits a typed error event', async () => {
    const events: MCPClientEvent[] = [];
    const { handle } = makeFake({ connectThrows: 'ECONNREFUSED' });
    const mgr = new MCPClientManager({
      factory: () => handle,
      onEvent: (e) => events.push(e),
    });
    mgr.register(cfg('dead'));
    const instance = await mgr.start('dead');

    expect(instance.state).toBe('failed');
    expect(instance.lastError?.code).toBe('connect_error');
    expect(instance.lastError?.message).toMatch(/ECONNREFUSED/);
    expect(events.some((e) => e.kind === 'error')).toBe(true);
  });

  it('fails with a specific code when listTools throws', async () => {
    const { handle } = makeFake({ listToolsThrows: 'protocol mismatch' });
    const mgr = new MCPClientManager({ factory: () => handle });
    mgr.register(cfg('pickle'));
    const instance = await mgr.start('pickle');
    expect(instance.state).toBe('failed');
    expect(instance.lastError?.code).toBe('list_tools_error');
  });

  it('refuses to call a tool on a non-ready client', async () => {
    const { handle } = makeFake({ connectThrows: 'boom' });
    const mgr = new MCPClientManager({ factory: () => handle });
    mgr.register(cfg('down'));
    await mgr.start('down');
    const res = await mgr.callTool('down', 'any', {});
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('client_not_ready');
  });

  it('calls a tool and emits a tool_call event with timing', async () => {
    const events: MCPClientEvent[] = [];
    const { handle } = makeFake({
      tools: [{ name: 'search' }],
    });
    const mgr = new MCPClientManager({
      factory: () => handle,
      onEvent: (e) => events.push(e),
    });
    mgr.register(cfg('ok'));
    await mgr.start('ok');
    const res = await mgr.callTool('ok', 'search', { q: 'vichy' });
    expect(res.ok).toBe(true);
    const tc = events.find((e) => e.kind === 'tool_call');
    expect(tc).toBeDefined();
    if (tc && tc.kind === 'tool_call') {
      expect(tc.ok).toBe(true);
      expect(tc.tool).toBe('search');
      expect(typeof tc.durationMs).toBe('number');
    }
  });

  it('auto-recovers once on crash, then fails if the retry itself fails', async () => {
    vi.useFakeTimers();
    const events: MCPClientEvent[] = [];
    const crashCallbacks: Array<(err: MCPClientError) => void> = [];
    let factoryCalls = 0;

    const factory = () => {
      factoryCalls += 1;
      // First handle works; the retry handle fails to connect so the
      // retry never reaches 'ready' — retryUsed stays true → failed.
      const fake =
        factoryCalls === 1
          ? makeFake({ tools: [{ name: 't' }] })
          : makeFake({ connectThrows: 'retry failed' });
      crashCallbacks.push((err) => fake.triggerCrash(err));
      return fake.handle;
    };
    const mgr = new MCPClientManager({
      factory,
      retryDelayMs: 100,
      onEvent: (e) => events.push(e),
    });
    mgr.register(cfg('flaky'));
    await mgr.start('flaky');
    expect(mgr.get('flaky')?.state).toBe('ready');
    expect(factoryCalls).toBe(1);

    // Crash: silent retry kicks in but the retry itself fails — no budget
    // left within this incident (retryUsed wasn't reset by a ready
    // transition), so we end up in 'failed'.
    crashCallbacks[0]({
      code: 'subprocess_exit',
      message: 'exit 1',
      at: 't0',
    });
    await vi.runAllTimersAsync();
    expect(mgr.get('flaky')?.state).toBe('failed');
    expect(factoryCalls).toBe(2);

    vi.useRealTimers();
  });

  it('listReady reports only the subset of healthy clients (partial success)', async () => {
    const mgr = new MCPClientManager({
      factory: (c) =>
        c.name === 'dead'
          ? makeFake({ connectThrows: 'nope' }).handle
          : makeFake({ tools: [{ name: 'x' }] }).handle,
    });
    mgr.register(cfg('alive-1'));
    mgr.register(cfg('dead'));
    mgr.register(cfg('alive-2'));
    await mgr.startAll();
    const ready = mgr.listReady().map((c) => c.name).sort();
    expect(ready).toEqual(['alive-1', 'alive-2']);
    expect(mgr.get('dead')?.state).toBe('failed');
  });

  it('stop closes the handle and transitions to stopped', async () => {
    const close = vi.fn(async () => undefined);
    const { handle } = makeFake();
    handle.close = close;
    const mgr = new MCPClientManager({ factory: () => handle });
    mgr.register(cfg('alive'));
    await mgr.start('alive');
    await mgr.stop('alive');
    expect(close).toHaveBeenCalled();
    expect(mgr.get('alive')?.state).toBe('stopped');
  });

  it('après 60 s de stabilité, un nouvel incident a de nouveau sa reprise silencieuse', async () => {
    vi.useFakeTimers();
    const { factory, fakes } = recordingFactory({ tools: [{ name: 't' }] });
    const mgr = new MCPClientManager({ factory, retryDelayMs: 5 });
    mgr.register(cfg('resilient'));
    await mgr.start('resilient');

    // Premier incident : crash, reprise silencieuse, de nouveau prêt.
    fakes[0].triggerCrash(CRASH);
    await vi.runAllTimersAsync();
    expect(mgr.get('resilient')?.state).toBe('ready');
    expect(fakes).toHaveLength(2);

    // Resté prêt une minute : l'incident suivant est indépendant, il a sa propre reprise.
    await vi.advanceTimersByTimeAsync(60_000);
    fakes[1].triggerCrash(CRASH);
    await vi.runAllTimersAsync();
    expect(mgr.get('resilient')?.state).toBe('ready');
    expect(fakes).toHaveLength(3);

    // La fenêtre se compte depuis le dernier passage à prêt : un crash aussitôt après est le
    // même incident, il n'a plus de reprise.
    fakes[2].triggerCrash(CRASH);
    await vi.runAllTimersAsync();
    expect(mgr.get('resilient')?.state).toBe('failed');
    expect(fakes).toHaveLength(3);

    vi.useRealTimers();
  });

  it('register duplicate name throws', () => {
    const mgr = new MCPClientManager({
      factory: () => makeFake().handle,
    });
    mgr.register(cfg('dup'));
    expect(() => mgr.register(cfg('dup'))).toThrow(/already registered/);
  });
});

/**
 * Le SDK appelle onclose même pour une fermeture voulue : `stop()` passait par onCrash, qui
 * programmait la « reprise silencieuse » 500 ms plus tard. Un serveur retiré redevenait prêt,
 * ses outils repartaient au modèle (S09-1-0) ; « Redémarrer » laissait un second processus, et
 * un échec de listTools laissait le premier tourner (S09-1-1).
 */
describe('MCPClientManager : arrêté veut dire arrêté, un seul handle par client', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stop : la fermeture déclenche le crash, comme le SDK, et le client reste arrêté', async () => {
    vi.useFakeTimers();
    const events: MCPClientEvent[] = [];
    const { factory, fakes, open } = recordingFactory({ tools: [{ name: 't' }], closeCrashes: true });
    const mgr = new MCPClientManager({ factory, onEvent: (e) => events.push(e) });
    mgr.register(cfg('gallica'));
    await mgr.start('gallica');
    const before = events.length;

    await mgr.stop('gallica');
    await vi.runAllTimersAsync();

    expect(mgr.get('gallica')?.state).toBe('stopped');
    expect(mgr.listReady()).toEqual([]);
    expect(fakes).toHaveLength(1);
    expect(open()).toBe(0);
    // Une fermeture voulue n'est pas un incident : rien d'autre que le passage à « stopped ».
    expect(events.slice(before).map((e) => (e.kind === 'state_changed' ? e.to : e.kind))).toEqual(['stopped']);
  });

  it('stopAll : idem pour chaque client, aucun ne revient', async () => {
    vi.useFakeTimers();
    const { factory, fakes, open } = recordingFactory({ tools: [{ name: 't' }], closeCrashes: true });
    const mgr = new MCPClientManager({ factory });
    mgr.register(cfg('a'));
    mgr.register(cfg('b'));
    await mgr.startAll();

    await mgr.stopAll();
    await vi.runAllTimersAsync();

    expect(mgr.listAll().map((c) => c.state)).toEqual(['stopped', 'stopped']);
    expect(fakes).toHaveLength(2);
    expect(open()).toBe(0);
  });

  it('« Redémarrer » (stop puis start) : un seul handle ouvert à la fin', async () => {
    vi.useFakeTimers();
    const { factory, fakes, open } = recordingFactory({ tools: [{ name: 't' }], closeCrashes: true });
    const mgr = new MCPClientManager({ factory });
    mgr.register(cfg('gallica'));
    await mgr.start('gallica');

    await mgr.stop('gallica');
    await mgr.start('gallica');
    await vi.runAllTimersAsync();

    expect(mgr.get('gallica')?.state).toBe('ready');
    expect(fakes).toHaveLength(2);
    expect(open()).toBe(1);
  });

  it('« Redémarrer » pendant que la reprise ferme l’ancien handle : un seul handle ouvert', async () => {
    vi.useFakeTimers();
    const { factory, fakes, open } = recordingFactory({ tools: [{ name: 't' }], closeDelayMs: 300 });
    const mgr = new MCPClientManager({ factory, retryDelayMs: 5 });
    mgr.register(cfg('gallica'));
    await mgr.start('gallica');

    // Le serveur plante ; la reprise part et attend la fermeture de l'ancien handle.
    fakes[0].triggerCrash(CRASH);
    await vi.advanceTimersByTimeAsync(5);
    expect(mgr.get('gallica')?.state).toBe('spawning');
    expect(fakes[0].isClosed()).toBe(true);
    expect(fakes).toHaveLength(1);

    // L'historien clique sur « Redémarrer » pendant cette attente.
    await mgr.stop('gallica');
    await mgr.start('gallica');
    // La reprise, relayée, finit d'attendre la fermeture : elle ne lance pas un second processus.
    await vi.runAllTimersAsync();

    expect(mgr.get('gallica')?.state).toBe('ready');
    expect(fakes).toHaveLength(2);
    expect(open()).toBe(1);
  });

  it('listTools refusé (-32601) : échec, et le handle est fermé', async () => {
    const { factory, fakes, open } = recordingFactory({ listToolsThrows: 'MCP error -32601: Method not found' });
    const mgr = new MCPClientManager({ factory });
    mgr.register(cfg('sans-outils'));

    const instance = await mgr.start('sans-outils');

    expect(instance.state).toBe('failed');
    expect(instance.lastError?.code).toBe('list_tools_error');
    expect(fakes).toHaveLength(1);
    expect(open()).toBe(0);
  });

  it('crash tardif d’un handle remplacé : le handle courant reste ouvert, aucune reprise', async () => {
    vi.useFakeTimers();
    const { factory, fakes } = recordingFactory({ tools: [{ name: 't' }] });
    const mgr = new MCPClientManager({ factory, retryDelayMs: 5 });
    mgr.register(cfg('gallica'));
    await mgr.start('gallica');
    await mgr.stop('gallica');
    await mgr.start('gallica');

    // L'ancien processus finit de mourir après le redémarrage.
    fakes[0].triggerCrash(CRASH);
    await vi.runAllTimersAsync();

    expect(mgr.get('gallica')?.state).toBe('ready');
    expect(fakes).toHaveLength(2);
    expect(fakes[1].isClosed()).toBe(false);
  });

  it('startAll ne relance pas un client déjà prêt', async () => {
    const { factory, fakes, open } = recordingFactory({ tools: [{ name: 't' }] });
    const mgr = new MCPClientManager({ factory });
    mgr.register(cfg('gallica'));
    await mgr.start('gallica');

    await mgr.startAll();

    expect(mgr.get('gallica')?.state).toBe('ready');
    expect(fakes).toHaveLength(1);
    expect(open()).toBe(1);
  });

  it('un serveur qui meurt juste après sa poignée de main finit en échec après une seule reprise', async () => {
    vi.useFakeTimers();
    const { factory, fakes, open } = recordingFactory({ tools: [{ name: 't' }] });
    const mgr = new MCPClientManager({ factory, retryDelayMs: 5 });
    mgr.register(cfg('instable'));
    await mgr.start('instable');

    fakes[0].triggerCrash(CRASH);
    await vi.runAllTimersAsync();
    expect(mgr.get('instable')?.state).toBe('ready');

    fakes[1].triggerCrash(CRASH);
    await vi.runAllTimersAsync();

    expect(mgr.get('instable')?.state).toBe('failed');
    expect(fakes).toHaveLength(2);
    expect(open()).toBe(0);

    // État terminal, pas une impasse : « Redémarrer » repart avec un budget neuf.
    await mgr.stop('instable');
    expect((await mgr.start('instable')).state).toBe('ready');
    expect(fakes).toHaveLength(3);
  });

  it('crash pendant la poignée de main : la reprise prend la main, pas de « ready » entre-temps', async () => {
    vi.useFakeTimers();
    const events: MCPClientEvent[] = [];
    const { factory, fakes, open } = recordingFactory({ tools: [{ name: 't' }] });
    const mgr = new MCPClientManager({
      factory: () => {
        const handle = factory();
        // Le premier serveur signale une erreur de transport pendant tools/list, puis répond quand même.
        if (fakes.length === 1) {
          const [first] = fakes;
          const listTools = handle.listTools;
          handle.listTools = async () => {
            first.triggerCrash(CRASH);
            return listTools();
          };
        }
        return handle;
      },
      retryDelayMs: 5,
      onEvent: (e) => events.push(e),
    });
    mgr.register(cfg('bavard'));

    await mgr.start('bavard');
    await vi.runAllTimersAsync();

    const states = events.flatMap((e) => (e.kind === 'state_changed' ? [e.to] : []));
    expect(states).toEqual(['spawning', 'handshaking', 'degraded', 'spawning', 'handshaking', 'ready']);
    expect(fakes).toHaveLength(2);
    expect(open()).toBe(1);
  });

  it('un serveur qui ne ferme pas ne retient ni stop, ni stopAll, ni la reprise', async () => {
    vi.useFakeTimers();
    const { factory, fakes } = recordingFactory({ tools: [{ name: 't' }], closeHangs: true });
    const mgr = new MCPClientManager({ factory, retryDelayMs: 5, closeTimeoutMs: 1_000 });
    mgr.register(cfg('a'));
    mgr.register(cfg('b'));
    await mgr.startAll();

    // Reprise après crash : l'ancien handle ne ferme pas, le nouveau part quand même.
    fakes[0].triggerCrash(CRASH);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(mgr.get('a')?.state).toBe('ready');
    expect(fakes).toHaveLength(3);

    let stopped = false;
    void mgr.stop('b').then(() => {
      stopped = true;
    });
    let allStopped = false;
    void mgr.stopAll().then(() => {
      allStopped = true;
    });
    await vi.advanceTimersByTimeAsync(1_100);

    expect(stopped).toBe(true);
    expect(allStopped).toBe(true);
    expect(mgr.listAll().map((c) => c.state)).toEqual(['stopped', 'stopped']);
  });
});
