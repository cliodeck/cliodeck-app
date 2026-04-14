import { describe, it, expect, vi } from 'vitest';
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
}

function makeFake(opts: FakeOptions = {}): {
  handle: MCPClientHandle;
  triggerCrash: (err: MCPClientError) => void;
} {
  let crashCb: (err: MCPClientError) => void = () => undefined;
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
      // no-op
    },
    onCrash(cb) {
      crashCb = cb;
    },
  };
  return { handle, triggerCrash: (err) => crashCb(err) };
}

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

  it('auto-recovers once on crash, then fails on a second crash', async () => {
    vi.useFakeTimers();
    const events: MCPClientEvent[] = [];
    const crashCallbacks: Array<(err: MCPClientError) => void> = [];
    let factoryCalls = 0;

    const factory = () => {
      factoryCalls += 1;
      const fake = makeFake({ tools: [{ name: 't' }] });
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

    // First crash: silent retry kicks in.
    crashCallbacks[0]({
      code: 'subprocess_exit',
      message: 'exit 1',
      at: 't0',
    });
    await vi.runAllTimersAsync();
    expect(mgr.get('flaky')?.state).toBe('ready');
    expect(factoryCalls).toBe(2);

    // Second crash on the same slot: no retry left — should bounce to failed.
    crashCallbacks[1]({
      code: 'subprocess_exit',
      message: 'exit 1',
      at: 't1',
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

  it('register duplicate name throws', () => {
    const mgr = new MCPClientManager({
      factory: () => makeFake().handle,
    });
    mgr.register(cfg('dup'));
    expect(() => mgr.register(cfg('dup'))).toThrow(/already registered/);
  });
});
