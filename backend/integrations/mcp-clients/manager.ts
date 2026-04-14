/**
 * MCPClientManager (fusion step 4.4.1 + 4.4.1bis).
 *
 * Manages the lifecycle of external MCP servers the workspace consumes.
 * Each client is a small state machine (`MCPClientState`) driven by the
 * manager — never a raw boolean `connected`. Every transition emits a
 * typed `MCPClientEvent` consumers subscribe to.
 *
 * Auto-recovery policy (claw-code lesson 6.4 — "infra oui, contenu non"):
 *   - Subprocess crash / transport disconnect is **infra**: one silent
 *     retry with backoff before bouncing to `failed`.
 *   - Tool-call failures are NOT retried here — the caller decides.
 *   - Re-entering `ready` after a retry fires a `state_changed` event so
 *     the UI can collapse/dismiss the transient failed badge.
 *
 * Partial success: `listReady()` and `listAll()` let callers route search
 * queries to the subset of ready clients while the rest reconnect — the
 * UI surfaces a "N of M sources available" badge instead of failing the
 * whole operation when one server is down.
 *
 * The *client factory* is injected. Tests pass a fake factory that
 * simulates state transitions synchronously; production wires it to the
 * real `@modelcontextprotocol/sdk` Client + StdioClient/SseClient
 * transports (factory implementations not in this scaffold — the
 * SDK wiring is narrow enough to arrive when the renderer settings UI
 * lets the historian add a server).
 */

import type {
  MCPClientConfig,
  MCPClientError,
  MCPClientEvent,
  MCPClientInstance,
  MCPClientState,
  MCPToolDescriptor,
} from './types.js';

export interface MCPClientHandle {
  /** Initialize (spawn subprocess, open socket, MCP handshake). */
  connect(): Promise<void>;
  /** Enumerate the server's tools after handshake. */
  listTools(): Promise<MCPToolDescriptor[]>;
  /** Call a tool; `ok` false means the call failed at protocol level. */
  callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; result?: unknown; error?: MCPClientError }>;
  /** Release resources; idempotent. */
  close(): Promise<void>;
  /**
   * Fires when the transport hits an unrecoverable error (subprocess
   * crash, socket reset). The manager reacts by transitioning the
   * client's state and scheduling a single silent retry.
   */
  onCrash(cb: (err: MCPClientError) => void): void;
}

export type MCPClientFactory = (cfg: MCPClientConfig) => MCPClientHandle;

export interface MCPClientManagerOptions {
  factory: MCPClientFactory;
  /** Milliseconds to wait before the one silent retry. Default 500. */
  retryDelayMs?: number;
  /** Event sink (UI reducer, JSONL audit logger). */
  onEvent?: (e: MCPClientEvent) => void;
}

interface Slot {
  cfg: MCPClientConfig;
  handle: MCPClientHandle | null;
  instance: MCPClientInstance;
  /** True if the one silent retry has been spent for the current incident. */
  retryUsed: boolean;
}

function now(): string {
  return new Date().toISOString();
}

export class MCPClientManager {
  private readonly factory: MCPClientFactory;
  private readonly retryDelayMs: number;
  private readonly emit: (e: MCPClientEvent) => void;
  private readonly slots = new Map<string, Slot>();

  constructor(opts: MCPClientManagerOptions) {
    this.factory = opts.factory;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    this.emit = opts.onEvent ?? (() => undefined);
  }

  // MARK: - introspection

  listAll(): MCPClientInstance[] {
    return [...this.slots.values()].map((s) => s.instance);
  }

  listReady(): MCPClientInstance[] {
    return this.listAll().filter((i) => i.state === 'ready');
  }

  get(name: string): MCPClientInstance | null {
    return this.slots.get(name)?.instance ?? null;
  }

  // MARK: - lifecycle

  register(cfg: MCPClientConfig): void {
    if (this.slots.has(cfg.name)) {
      throw new Error(`MCP client "${cfg.name}" already registered`);
    }
    this.slots.set(cfg.name, {
      cfg,
      handle: null,
      retryUsed: false,
      instance: {
        name: cfg.name,
        state: 'unconfigured',
        tools: [],
        generation: 0,
      },
    });
  }

  /** Start a single client by name. Idempotent when already ready. */
  async start(name: string): Promise<MCPClientInstance> {
    const slot = this.requireSlot(name);
    if (slot.instance.state === 'ready' || slot.instance.state === 'spawning' || slot.instance.state === 'handshaking') {
      return slot.instance;
    }
    return this.bootstrap(slot);
  }

  /** Start every registered client that has `autoStart !== false`. */
  async startAll(): Promise<MCPClientInstance[]> {
    const promises = [...this.slots.values()]
      .filter((s) => s.cfg.autoStart !== false)
      .map((s) => this.bootstrap(s).catch(() => s.instance));
    return Promise.all(promises);
  }

  async stop(name: string, reason: 'requested' | 'manager_shutdown' = 'requested'): Promise<void> {
    const slot = this.slots.get(name);
    if (!slot) return;
    if (slot.handle) {
      try {
        await slot.handle.close();
      } catch {
        // swallow — closing is best-effort
      }
      slot.handle = null;
    }
    this.transition(slot, 'stopped', reason);
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.slots.keys()].map((n) => this.stop(n, 'manager_shutdown'))
    );
  }

  async callTool(
    name: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; result?: unknown; error?: MCPClientError }> {
    const slot = this.requireSlot(name);
    if (slot.instance.state !== 'ready' || !slot.handle) {
      return {
        ok: false,
        error: {
          code: 'client_not_ready',
          message: `MCP client "${name}" is in state "${slot.instance.state}"`,
          at: now(),
        },
      };
    }
    const started = Date.now();
    const res = await slot.handle.callTool(tool, args);
    this.emit({
      kind: 'tool_call',
      at: now(),
      name,
      tool,
      durationMs: Date.now() - started,
      ok: res.ok,
      errorCode: res.error?.code,
    });
    return res;
  }

  // MARK: - internals

  private requireSlot(name: string): Slot {
    const slot = this.slots.get(name);
    if (!slot) throw new Error(`Unknown MCP client: ${name}`);
    return slot;
  }

  private async bootstrap(slot: Slot): Promise<MCPClientInstance> {
    slot.retryUsed = false;
    return this.attemptConnect(slot, false);
  }

  private async attemptConnect(
    slot: Slot,
    isRetry: boolean
  ): Promise<MCPClientInstance> {
    this.transition(slot, 'spawning', isRetry ? 'retry' : 'initial');
    let handle: MCPClientHandle;
    try {
      handle = this.factory(slot.cfg);
      slot.handle = handle;
      handle.onCrash((err) => this.onCrash(slot, err));
    } catch (e) {
      return this.fail(slot, {
        code: 'factory_error',
        message: e instanceof Error ? e.message : String(e),
        at: now(),
      });
    }

    try {
      await handle.connect();
    } catch (e) {
      return this.fail(slot, {
        code: 'connect_error',
        message: e instanceof Error ? e.message : String(e),
        at: now(),
      });
    }
    this.transition(slot, 'handshaking');

    let tools: MCPToolDescriptor[];
    try {
      tools = await handle.listTools();
    } catch (e) {
      return this.fail(slot, {
        code: 'list_tools_error',
        message: e instanceof Error ? e.message : String(e),
        at: now(),
      });
    }

    slot.instance = {
      ...slot.instance,
      tools,
      lastReadyAt: now(),
      lastError: undefined,
      generation: slot.instance.generation + 1,
    };
    this.emit({
      kind: 'tools_updated',
      at: now(),
      name: slot.cfg.name,
      tools,
    });
    this.transition(slot, 'ready');
    return slot.instance;
  }

  private async onCrash(slot: Slot, err: MCPClientError): Promise<void> {
    this.emit({ kind: 'error', at: now(), name: slot.cfg.name, error: err });
    // Detach the dead handle; we'll rebuild via the factory on retry.
    if (slot.handle) {
      try {
        await slot.handle.close();
      } catch {
        // best effort
      }
      slot.handle = null;
    }
    if (slot.retryUsed) {
      this.fail(slot, err);
      return;
    }
    slot.retryUsed = true;
    this.transition(slot, 'degraded', 'retry_scheduled');
    // Schedule the single silent retry; don't await — the caller shouldn't
    // block on recovery.
    setTimeout(() => {
      void this.attemptConnect(slot, true);
    }, this.retryDelayMs);
  }

  private fail(slot: Slot, err: MCPClientError): MCPClientInstance {
    slot.instance = {
      ...slot.instance,
      lastError: err,
      generation: slot.instance.generation + 1,
    };
    this.emit({ kind: 'error', at: now(), name: slot.cfg.name, error: err });
    this.transition(slot, 'failed', err.code);
    return slot.instance;
  }

  private transition(
    slot: Slot,
    to: MCPClientState,
    reason?: string
  ): void {
    const from = slot.instance.state;
    if (from === to) return;
    slot.instance = {
      ...slot.instance,
      state: to,
      generation: slot.instance.generation + 1,
    };
    this.emit({
      kind: 'state_changed',
      at: now(),
      name: slot.cfg.name,
      from,
      to,
      reason,
    });
  }
}
