/**
 * MCPClientManager (fusion step 4.4.1 + 4.4.1bis).
 *
 * Manages the lifecycle of external MCP servers the workspace consumes.
 * Each client is a small state machine (`MCPClientState`) driven by the
 * manager — never a raw boolean `connected`. Every transition emits a
 * typed `MCPClientEvent` consumers subscribe to.
 *
 * Auto-recovery policy (claw-code lesson 6.4 — "infra oui, contenu non"):
 *   - Subprocess crash / transport disconnect is **infra**: une seule reprise
 *     silencieuse par incident, après `retryDelayMs`, puis `failed` — état
 *     terminal, que « Redémarrer » relance avec un budget neuf.
 *   - Le budget ne se recharge qu'après `stabilityWindowMs` passés prêt : un
 *     serveur qui meurt juste après sa poignée de main relançait sans fin.
 *   - Arrêté veut dire arrêté : le SDK appelle onclose même pour une fermeture
 *     voulue, et seul le crash du handle courant d'un client qu'on n'a pas
 *     arrêté est un incident. Un seul handle (un seul processus) par client.
 *   - Fermer un handle est borné (`closeTimeoutMs`) : un serveur qui ne ferme
 *     pas ne retient ni l'arrêt ni la reprise.
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
  /** Temps passé prêt au-delà duquel un crash est un nouvel incident, avec sa reprise. Défaut 60 s. */
  stabilityWindowMs?: number;
  /**
   * Attente maximale de la fermeture d'un handle. Défaut 5 s : le transport stdio du SDK tue
   * lui-même un serveur récalcitrant (SIGTERM à 2 s, SIGKILL à 4 s).
   */
  closeTimeoutMs?: number;
  /** Event sink (UI reducer, JSONL audit logger). */
  onEvent?: (e: MCPClientEvent) => void;
}

interface Slot {
  cfg: MCPClientConfig;
  handle: MCPClientHandle | null;
  instance: MCPClientInstance;
  /** True if the one silent retry has been spent for the current incident. */
  retryUsed: boolean;
  /** Arrêt demandé : ni un crash ni une reprise programmée ne relancent le client. Levé par start(). */
  stopRequested: boolean;
  /** Reprise silencieuse programmée, annulée par stop(), start() et l'échec. */
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Date.now() du dernier passage à ready, null hors de ready : mesure la fenêtre de stabilité. */
  readySinceMs: number | null;
  /** Numéro de la dernière tentative de connexion : une tentative relayée pendant une attente abandonne. */
  attempt: number;
}

function now(): string {
  return new Date().toISOString();
}

export class MCPClientManager {
  private readonly factory: MCPClientFactory;
  private readonly retryDelayMs: number;
  private readonly stabilityWindowMs: number;
  private readonly closeTimeoutMs: number;
  private readonly emit: (e: MCPClientEvent) => void;
  private readonly slots = new Map<string, Slot>();

  constructor(opts: MCPClientManagerOptions) {
    this.factory = opts.factory;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    this.stabilityWindowMs = opts.stabilityWindowMs ?? 60_000;
    this.closeTimeoutMs = opts.closeTimeoutMs ?? 5_000;
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
      stopRequested: false,
      retryTimer: null,
      readySinceMs: null,
      attempt: 0,
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

  /**
   * Start every registered client that has `autoStart !== false`. Comme start(), laisse en
   * place un client déjà prêt ou en cours de connexion : sinon son handle serait écrasé, vivant.
   */
  async startAll(): Promise<MCPClientInstance[]> {
    const promises = [...this.slots.values()]
      .filter((s) => s.cfg.autoStart !== false)
      .map((s) => this.start(s.cfg.name).catch(() => s.instance));
    return Promise.all(promises);
  }

  async stop(name: string, reason: 'requested' | 'manager_shutdown' = 'requested'): Promise<void> {
    const slot = this.slots.get(name);
    if (!slot) return;
    // Intention posée et reprise annulée AVANT la fermeture : le SDK appelle onclose même pour
    // une fermeture voulue, et un serveur retiré revenait prêt 500 ms plus tard.
    slot.stopRequested = true;
    this.cancelRetry(slot);
    slot.readySinceMs = null;
    // Détaché avant close() : son onclose tombe sur le garde d'identité d'onCrash.
    const handle = slot.handle;
    slot.handle = null;
    // Arrêté dès maintenant : ses outils ne sont plus offerts au modèle pendant la fermeture.
    this.transition(slot, 'stopped', reason);
    if (handle) await this.closeHandle(handle);
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
    slot.stopRequested = false;
    this.cancelRetry(slot);
    slot.retryUsed = false;
    return this.attemptConnect(slot, false);
  }

  private async attemptConnect(
    slot: Slot,
    isRetry: boolean
  ): Promise<MCPClientInstance> {
    const attempt = ++slot.attempt;
    this.transition(slot, 'spawning', isRetry ? 'retry' : 'initial');
    // Un seul processus par client : l'ancien handle (celui d'une reprise après crash) est fermé
    // avant d'en lancer un autre. Attente bornée, et relayée si on arrête ou relance entre-temps.
    const previous = slot.handle;
    if (previous) {
      slot.handle = null;
      await this.closeHandle(previous);
      if (slot.stopRequested || slot.attempt !== attempt) return slot.instance;
    }

    let handle: MCPClientHandle;
    try {
      const created = this.factory(slot.cfg);
      handle = created;
      slot.handle = created;
      // Lié au handle capturé : le crash d'un handle fermé ou remplacé n'est pas un incident.
      created.onCrash((err) => this.onCrash(slot, created, err));
    } catch (e) {
      return this.fail(slot, {
        code: 'factory_error',
        message: e instanceof Error ? e.message : String(e),
        at: now(),
      });
    }

    // Après chaque attente, cette tentative s'efface si elle a été relayée : par stop() ou par une
    // nouvelle tentative, qui ont détaché et fermé son handle, ou par onCrash, qui a programmé la
    // reprise.
    const superseded = (): boolean => slot.handle !== handle || slot.retryTimer !== null;
    try {
      await handle.connect();
    } catch (e) {
      if (superseded()) return slot.instance;
      return this.fail(slot, {
        code: 'connect_error',
        message: e instanceof Error ? e.message : String(e),
        at: now(),
      });
    }
    if (superseded()) return slot.instance;
    this.transition(slot, 'handshaking');

    let tools: MCPToolDescriptor[];
    try {
      tools = await handle.listTools();
    } catch (e) {
      if (superseded()) return slot.instance;
      return this.fail(slot, {
        code: 'list_tools_error',
        message: e instanceof Error ? e.message : String(e),
        at: now(),
      });
    }
    if (superseded()) return slot.instance;

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
    // Le budget de reprise n'est PAS rechargé ici : seul un crash survenu après la fenêtre de
    // stabilité (onCrash) ouvre un nouvel incident.
    slot.readySinceMs = Date.now();
    this.transition(slot, 'ready');
    return slot.instance;
  }

  private onCrash(slot: Slot, handle: MCPClientHandle, err: MCPClientError): void {
    // Fermeture voulue (arrêt, échec, handle remplacé) : le SDK appelle quand même onclose, et ce
    // n'est pas un incident. Rien n'est journalisé ni relancé.
    if (slot.handle !== handle || slot.stopRequested) return;
    this.emit({ kind: 'error', at: now(), name: slot.cfg.name, error: err });
    // Resté prêt assez longtemps : incident nouveau, avec sa propre reprise.
    if (slot.readySinceMs !== null && Date.now() - slot.readySinceMs >= this.stabilityWindowMs) {
      slot.retryUsed = false;
    }
    slot.readySinceMs = null;
    if (slot.retryUsed) {
      this.fail(slot, err);
      return;
    }
    slot.retryUsed = true;
    this.transition(slot, 'degraded', 'retry_scheduled');
    // Schedule the single silent retry; don't await — the caller shouldn't
    // block on recovery. Le handle mort reste attaché : la reprise le ferme avant d'en lancer un
    // autre, et stop() l'annule.
    slot.retryTimer = setTimeout(() => {
      slot.retryTimer = null;
      if (slot.stopRequested) return;
      void this.attemptConnect(slot, true);
    }, this.retryDelayMs);
  }

  private cancelRetry(slot: Slot): void {
    if (slot.retryTimer) clearTimeout(slot.retryTimer);
    slot.retryTimer = null;
  }

  /** Ferme en best-effort, sans jamais attendre plus de `closeTimeoutMs`. */
  private async closeHandle(handle: MCPClientHandle): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.closeTimeoutMs);
    });
    try {
      await Promise.race([handle.close(), deadline]);
    } catch {
      // swallow — closing is best-effort
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(slot: Slot, err: MCPClientError): MCPClientInstance {
    this.cancelRetry(slot);
    slot.readySinceMs = null;
    // Un client en échec ne garde aucun processus : un listTools refusé laissait le serveur tourner.
    const handle = slot.handle;
    slot.handle = null;
    if (handle) void this.closeHandle(handle);
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
