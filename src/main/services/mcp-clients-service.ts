/**
 * Singleton manager for workspace MCP clients in the Electron main process.
 *
 * Responsibilities:
 *   - Read MCP client definitions from the workspace v2 config
 *     (`WorkspaceConfig.mcpClients`, flat shape) and adapt them to the
 *     manager's nested `MCPClientConfig`.
 *   - Own a single `MCPClientManager` instance with the real SDK factory.
 *   - Start clients on `loadProject()`, stop on `unload()`.
 *   - Surface events to any number of listeners (IPC handlers subscribe).
 *
 * Design: this service is intentionally thin. All lifecycle / retry logic
 * lives in `MCPClientManager`. Persistence (read/write) is delegated to
 * `readOrInitWorkspaceConfig` / `updateWorkspaceConfig` so the single source
 * of truth for workspace state stays the v2 config.json file. Démarrer un
 * serveur peut prendre des minutes : jamais sous le verrou de ce fichier.
 */

import { MCPClientManager } from '../../../backend/integrations/mcp-clients/manager.js';
import type {
  MCPClientConfig as ManagerClientConfig,
  MCPClientEvent,
  MCPClientInstance,
} from '../../../backend/integrations/mcp-clients/types.js';
import { realMCPClientFactory } from '../../../backend/integrations/mcp-clients/sdk-factory.js';
import {
  readOrInitWorkspaceConfig,
  updateWorkspaceConfig,
  WorkspaceConfigError,
  type MCPClientConfig as WorkspaceClientConfig,
} from '../../../backend/core/workspace/config.js';
import {
  ensureWorkspaceDirectories,
  workspaceFiles,
} from '../../../backend/core/workspace/layout.js';
import { workspaceLinkOutside } from '../../../backend/core/workspace/link-guard.js';
import { createWriteStream, type WriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { redactForAudit } from '../../../backend/mcp-server/audit.js';
import {
  deleteClientEnvSecrets,
  migrateClientEnvSecrets,
  resolveClientEnvSecrets,
} from './mcp-env-secrets.js';

/**
 * Un autre projet s'est ouvert pendant l'opération : elle s'arrête là. Le message est le mot que
 * l'IPC renvoie tel quel et que le renderer reconnaît (`refusedAsProjectChanged`).
 */
function projectChanged(): Error {
  return new Error('project-changed');
}

export function toManagerConfig(w: WorkspaceClientConfig): ManagerClientConfig {
  if (w.transport === 'stdio') {
    if (!w.command) {
      throw new Error(`MCP client "${w.name}": stdio transport requires a command`);
    }
    return {
      name: w.name,
      config: {
        transport: 'stdio',
        command: w.command,
        args: w.args,
        // Resolve sentinels against `secureStorage` here — the spawned
        // MCP server expects the actual API key, not the placeholder
        // that lives in `config.json`. (fusion 1.5)
        env: resolveClientEnvSecrets(w.name, w.env),
      },
    };
  }
  if (!w.url) {
    throw new Error(`MCP client "${w.name}": sse transport requires a url`);
  }
  return {
    name: w.name,
    config: { transport: 'sse', url: w.url },
  };
}

class MCPClientsService {
  private manager: MCPClientManager | null = null;
  private workspaceRoot: string | null = null;
  private listeners = new Set<(e: MCPClientEvent) => void>();
  private auditLogStream: WriteStream | null = null;
  /**
   * Avance à chaque détachement (unload, ou ouverture d'un autre projet). Un `loadProject` qui
   * reprend après une attente sur une génération dépassée a été relayé : il s'arrête là, et son
   * manager comme son journal ont déjà été arrêtés par qui les a détachés.
   */
  private loadGeneration = 0;

  /**
   * Écrit dans le flux passé en paramètre, jamais dans le champ vivant du
   * singleton : un callTool en vol sur l'ANCIEN manager peut se résoudre
   * après la bascule de projet, et lire `this.auditLogStream` à ce moment
   * enverrait son entrée dans le mcp-access.jsonl du NOUVEAU projet (#39).
   * Chaque manager est donc lié par closure au flux ouvert pour lui ; un
   * événement tardif sur un flux déjà fermé est perdu avec un warning
   * (intégrité d'attribution > complétude, pour un journal d'audit).
   */
  private writeAuditLog(stream: WriteStream | null, e: MCPClientEvent): void {
    if (!stream) return;
    try {
      // Reuse the central redaction helper so the file written by this
      // service stays in the same shape as the one written by the MCP
      // server logger (same key filtering, same env masking) — one audit
      // file, one contract.
      const redacted = redactForAudit(e);
      stream.write(JSON.stringify(redacted) + '\n');
    } catch (err) {
      console.warn('[mcp-clients] failed to write audit log entry:', err);
    }
  }

  async loadProject(root: string): Promise<void> {
    const previous = this.detach();
    // Lue sans attente après le détachement : seul un détachement postérieur la fait avancer.
    const generation = this.loadGeneration;
    const superseded = (): boolean => generation !== this.loadGeneration;
    await this.release(previous);
    if (superseded()) return;
    this.workspaceRoot = root;

    let auditLogStream: WriteStream | null = null;
    try {
      // Disparu (parent renommé, volume débranché) : surtout ne pas recréer un squelette de projet.
      await stat(root);
      if (superseded()) return;
      // `.cliodeck` lié hors du projet (D18) : ni dossier ni journal créés à l'autre bout du lien.
      const linked = await workspaceLinkOutside(root);
      if (superseded()) return;
      if (linked) throw new Error(`lien hors du projet : ${linked}`);
      await ensureWorkspaceDirectories(root);
      if (superseded()) return;
      auditLogStream = createWriteStream(workspaceFiles(root).mcpAccessLog, {
        flags: 'a',
      });
      auditLogStream.on('error', (err) => {
        console.warn('[mcp-clients] audit log stream error:', err);
      });
    } catch (err) {
      console.warn('[mcp-clients] failed to open audit log stream:', err);
    }
    if (superseded()) return;
    this.auditLogStream = auditLogStream;

    // Flux capturé par closure : ce manager n'écrira jamais dans le flux
    // d'un autre projet, même si un événement arrive après la bascule.
    const auditStreamForThisManager = auditLogStream;
    // Capturé lui aussi : après chaque attente, c'est ce manager-ci qu'on remplit, jamais
    // `this.manager` relu, qui peut être celui du projet ouvert entre-temps.
    const manager = new MCPClientManager({
      factory: realMCPClientFactory,
      onEvent: (e) => {
        this.writeAuditLog(auditStreamForThisManager, e);
        this.listeners.forEach((l) => {
          try {
            l(e);
          } catch {
            // ignore subscriber throws
          }
        });
      },
    });
    this.manager = manager;

    let clients: WorkspaceClientConfig[];
    try {
      clients = (await readOrInitWorkspaceConfig(root)).mcpClients ?? [];
    } catch (e) {
      // Illisible : le fichier reste tel quel, aucun serveur ne démarre, et le projet s'ouvre
      // quand même. L'interface l'a dit par `configIssue` ; un ajout le redira.
      if (!(e instanceof WorkspaceConfigError)) throw e;
      console.warn('[mcp-clients] config.json illisible, aucun serveur démarré:', e.message);
      return;
    }
    if (superseded()) return;

    // Fusion 1.5: any sensitive env value still in plain text inside
    // `config.json` is migrated to `secureStorage` on first load. The
    // config is only rewritten when at least one secret was actually
    // moved, so opening a workspace with no secrets is a no-op.
    try {
      const cfg = await updateWorkspaceConfig(root, (current) => {
        let migrated = false;
        for (const w of current.mcpClients ?? []) {
          if (migrateClientEnvSecrets(w)) migrated = true;
        }
        return migrated ? undefined : false;
      });
      clients = cfg.mcpClients ?? [];
    } catch (e) {
      console.warn('[mcp-clients] failed to persist secret migration:', e);
    }
    if (superseded()) return;

    // Ne JAMAIS démarrer ce que porte `config.json` sans l'avoir validé et
    // fait approuver : un projet partagé par un tiers exécuterait sinon la
    // commande de son choix à la simple ouverture (cf. mcp-approval-registry).
    const approved: WorkspaceClientConfig[] = [];
    for (const w of clients) {
      const verdict = await this.approvalGate(w, root);
      // Un autre projet ouvert pendant la question : ne rien démarrer, ne plus rien demander.
      if (superseded()) return;
      if (verdict === 'approved') {
        approved.push(w);
        continue;
      }
      console.warn(
        `[mcp-clients] serveur « ${w.name} » non démarré (${verdict})`
      );
    }

    for (const w of approved) {
      try {
        manager.register(toManagerConfig(w));
      } catch (e) {
        console.warn('[mcp-clients] skipping invalid client:', e);
      }
    }
    if (approved.length) {
      await manager.startAll();
    }
  }

  /**
   * Décide du sort d'un serveur déclaré dans le workspace : validation de
   * forme, puis approbation de l'utilisateur si l'empreinte est inconnue.
   * Remplaçable dans les tests.
   */
  approvalGate: (
    client: WorkspaceClientConfig,
    root: string
  ) => Promise<'approved' | 'rejected' | 'invalid'> = async (client, root) => {
    const { defaultMcpApprovalGate } = await import('./mcp-approval-gate.js');
    return defaultMcpApprovalGate(client, root);
  };

  async unload(): Promise<void> {
    await this.release(this.detach());
  }

  /**
   * Retire au service son manager et son journal, sans attendre : une opération en vol qui
   * reprend après une attente ne les retrouve plus, et la génération a avancé.
   */
  private detach(): { manager: MCPClientManager | null; stream: WriteStream | null } {
    this.loadGeneration += 1;
    const detached = { manager: this.manager, stream: this.auditLogStream };
    this.manager = null;
    this.workspaceRoot = null;
    this.auditLogStream = null;
    return detached;
  }

  /**
   * Arrête les serveurs (attente bornée par le manager), puis ferme le journal, qui a reçu leurs
   * derniers événements.
   */
  private async release(detached: {
    manager: MCPClientManager | null;
    stream: WriteStream | null;
  }): Promise<void> {
    await detached.manager?.stopAll();
    if (detached.stream) {
      try {
        detached.stream.end();
      } catch (err) {
        console.warn('[mcp-clients] failed to close audit log stream:', err);
      }
    }
  }

  list(): MCPClientInstance[] {
    return this.manager?.listAll() ?? [];
  }

  subscribe(cb: (e: MCPClientEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async addClient(client: WorkspaceClientConfig): Promise<MCPClientInstance> {
    // Projet et manager capturés à l'entrée : après une attente, `this.*` peut être le projet suivant.
    const root = this.workspaceRoot;
    const manager = this.manager;
    if (!root || !manager) {
      throw new Error('No project loaded');
    }
    await updateWorkspaceConfig(root, (cfg) => {
      // Un autre projet ouvert pendant l'attente du verrou ou la lecture : rien n'est écrit.
      if (this.manager !== manager) throw projectChanged();
      const existing = cfg.mcpClients ?? [];
      if (existing.some((c) => c.name === client.name)) {
        throw new Error(`MCP client "${client.name}" already exists`);
      }
      // Route fresh secrets straight to `secureStorage` so they never
      // touch `config.json`. The migration step above handles previously
      // persisted plain values; this catches new ones at the door.
      migrateClientEnvSecrets(client);
      cfg.mcpClients = [...existing, client];
    });
    // Écrit : l'ajout est fait, dans le config.json de CE projet. Si un autre projet s'est ouvert
    // pendant l'écriture, pas de refus (il dirait que rien n'a été écrit), mais rien n'est inscrit
    // ni démarré dans le manager abandonné : le serveur démarrera avec les autres serveurs déclarés,
    // au prochain chargement de ce projet.
    if (this.manager !== manager) {
      return { name: client.name, state: 'unconfigured', tools: [], generation: 0 };
    }
    manager.register(toManagerConfig(client));
    return manager.start(client.name);
  }

  async removeClient(name: string): Promise<void> {
    const root = this.workspaceRoot;
    const manager = this.manager;
    if (!root || !manager) {
      throw new Error('No project loaded');
    }
    let removed: WorkspaceClientConfig | undefined;
    await updateWorkspaceConfig(root, (cfg) => {
      // Un autre projet ouvert pendant l'attente du verrou ou la lecture : rien n'est écrit.
      if (this.manager !== manager) throw projectChanged();
      removed = (cfg.mcpClients ?? []).find((c) => c.name === name);
      cfg.mcpClients = (cfg.mcpClients ?? []).filter((c) => c.name !== name);
    });
    if (removed) deleteClientEnvSecrets(removed);
    // Écrit : le retrait est fait. On arrête le serveur de CE projet, sur le manager capturé —
    // déjà arrêté par la bascule si un autre projet s'est ouvert pendant l'écriture.
    await manager.stop(name);
  }

  async restart(name: string): Promise<MCPClientInstance | null> {
    const manager = this.manager;
    if (!manager) return null;
    await manager.stop(name);
    // Un autre projet ouvert pendant l'arrêt : rien ne repart dans un manager abandonné.
    if (this.manager !== manager) throw projectChanged();
    return manager.start(name);
  }

  async callTool(
    name: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> {
    if (!this.manager) {
      return { ok: false, error: { code: 'no_manager', message: 'No project loaded' } };
    }
    const res = await this.manager.callTool(name, tool, args);
    return {
      ok: res.ok,
      result: res.result,
      error: res.error ? { code: res.error.code, message: res.error.message } : undefined,
    };
  }
}

export const mcpClientsService = new MCPClientsService();
