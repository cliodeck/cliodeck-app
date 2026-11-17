/**
 * Singleton manager for workspace MCP clients in the Electron main process.
 *
 * Responsibilities:
 *   - Read MCP client definitions from the workspace v2 config
 *     (`WorkspaceConfig.mcpClients`, flat shape) and adapt them to the
 *     manager's nested `MCPClientConfig`.
 *   - Own a single `MCPClientManager` instance with the real SDK factory.
 *   - Start clients on `loadProject()`, stop on `unload()`. La séquence des projets l'appelle à
 *     chaque ouverture, en arrière-plan (A10).
 *   - Surface events to any number of listeners (IPC handlers subscribe).
 *
 * Design: this service is intentionally thin. All lifecycle / retry logic
 * lives in `MCPClientManager`. Persistence (read/write) is delegated to
 * `readWorkspaceConfig` / `updateWorkspaceConfig` so the single source
 * of truth for workspace state stays the v2 config.json file. Démarrer un
 * serveur peut prendre des minutes : jamais sous le verrou de ce fichier.
 * Ouvrir un projet sans serveur n'écrit rien dans son `.cliodeck` (A10).
 */

import { MCPClientManager } from '../../../backend/integrations/mcp-clients/manager.js';
import type {
  MCPClientConfig as ManagerClientConfig,
  MCPClientEvent,
  MCPClientInstance,
} from '../../../backend/integrations/mcp-clients/types.js';
import { realMCPClientFactory } from '../../../backend/integrations/mcp-clients/sdk-factory.js';
import {
  readWorkspaceConfig,
  updateWorkspaceConfig,
  WorkspaceConfigError,
  type MCPClientConfig as WorkspaceClientConfig,
} from '../../../backend/core/workspace/config.js';
import { workspaceFiles } from '../../../backend/core/workspace/layout.js';
import { workspaceLinkOutside } from '../../../backend/core/workspace/link-guard.js';
import type { ProjectHandle } from '../../../backend/types/project-handle.js';
import { createWriteStream, type WriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { redactForAudit } from '../../../backend/mcp-server/audit.js';
import {
  clientHasSecrets,
  deleteClientEnvSecrets,
  discardUnsavedScope,
  ensureSecretsScope,
  migrateClientEnvSecrets,
  resolveClientEnvSecrets,
  secretsMigrationDue,
  secretsScopeOf,
} from './mcp-env-secrets.js';

/**
 * Un autre projet s'est ouvert pendant l'opération : elle s'arrête là. Le message est le mot que
 * l'IPC renvoie tel quel et que le renderer reconnaît (`refusedAsProjectChanged`).
 */
function projectChanged(): Error {
  return new Error('project-changed');
}

/** `scope` : la portée des secrets du projet (`secrets_scope`), `null` s'il n'en a pas. */
export function toManagerConfig(w: WorkspaceClientConfig, scope: string | null): ManagerClientConfig {
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
        env: resolveClientEnvSecrets(scope, w.name, w.env),
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

/**
 * Le journal d'accès d'un manager (`mcp-access.jsonl`), ouvert à sa première entrée : un projet sans
 * serveur n'en gagne pas un vide à chaque ouverture (A10). Il ne crée aucun dossier, et jamais celui
 * d'un projet disparu : `.cliodeck` existe dès qu'un serveur y est déclaré ou ajouté.
 *
 * Chaque manager a le sien, lié par closure : un callTool en vol sur l'ANCIEN manager peut se
 * résoudre après la bascule de projet, et lire un champ du singleton à ce moment enverrait son entrée
 * dans le mcp-access.jsonl du NOUVEAU projet (#39). Fermé, il n'écrit plus rien : un événement tardif
 * est perdu avec un warning (intégrité d'attribution > complétude, pour un journal d'audit).
 */
class AccessLog {
  private stream: WriteStream | null = null;
  private closed = false;

  /** `file` null : aucun journal (`.cliodeck` lié hors du projet, ou dossier introuvable). */
  constructor(private readonly file: string | null) {}

  write(e: MCPClientEvent): void {
    if (!this.file) return;
    if (this.closed) {
      console.warn('[mcp-clients] audit log already closed, entry dropped:', e.kind, e.name);
      return;
    }
    try {
      if (!this.stream) {
        this.stream = createWriteStream(this.file, { flags: 'a' });
        this.stream.on('error', (err) => {
          console.warn('[mcp-clients] audit log stream error:', err);
        });
      }
      // Reuse the central redaction helper so the file written by this
      // service stays in the same shape as the one written by the MCP
      // server logger (same key filtering, same env masking) — one audit
      // file, one contract.
      this.stream.write(JSON.stringify(redactForAudit(e)) + '\n');
    } catch (err) {
      console.warn('[mcp-clients] failed to write audit log entry:', err);
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.stream?.end();
    } catch (err) {
      console.warn('[mcp-clients] failed to close audit log stream:', err);
    }
  }
}

class MCPClientsService {
  private manager: MCPClientManager | null = null;
  private workspaceRoot: string | null = null;
  private listeners = new Set<(e: MCPClientEvent) => void>();
  private accessLog: AccessLog | null = null;
  /**
   * Avance à chaque détachement (unload, ou ouverture d'un autre projet). Un `loadProject` qui
   * reprend après une attente sur une génération dépassée a été relayé : il s'arrête là, et son
   * manager comme son journal ont déjà été arrêtés par qui les a détachés.
   */
  private loadGeneration = 0;

  /**
   * `handle` : l'ouverture du projet, que la séquence passe (A10). Un appel sans handle (les tests du
   * service) ne s'arrête qu'à un détachement.
   */
  async loadProject(root: string, handle?: ProjectHandle): Promise<void> {
    const previous = this.detach();
    // Lue sans attente après le détachement : seul un détachement postérieur la fait avancer.
    const generation = this.loadGeneration;
    // La génération dit un détachement (unload, un autre chargement). Le handle le dit plus tôt : la
    // séquence l'avorte dès que la fermeture de cette ouverture commence (bascule, fermeture, sortie de
    // l'app), avant d'arriver à `unload`. Une question acceptée à ce moment ne lance plus rien.
    const superseded = (): boolean => generation !== this.loadGeneration || handle?.isCurrent() === false;
    await this.release(previous);
    if (superseded()) return;
    this.workspaceRoot = root;

    let accessFile: string | null = null;
    try {
      // Disparu (parent renommé, volume débranché) : surtout ne pas recréer un squelette de projet.
      await stat(root);
      if (superseded()) return;
      // `.cliodeck` lié hors du projet (D18) : aucun journal créé à l'autre bout du lien.
      const linked = await workspaceLinkOutside(root);
      if (superseded()) return;
      if (linked) throw new Error(`lien hors du projet : ${linked}`);
      accessFile = workspaceFiles(root).mcpAccessLog;
    } catch (err) {
      console.warn('[mcp-clients] audit log unavailable:', err);
    }
    if (superseded()) return;
    const accessLog = new AccessLog(accessFile);
    this.accessLog = accessLog;

    // Capturé : après chaque attente, c'est ce manager-ci qu'on remplit, jamais `this.manager` relu,
    // qui peut être celui du projet ouvert entre-temps. Son journal l'est aussi (`AccessLog`).
    const manager = new MCPClientManager({
      factory: realMCPClientFactory,
      onEvent: (e) => {
        accessLog.write(e);
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
    let scope: string | null;
    try {
      // Lu sans être créé : un projet sans `config.json` n'en gagne pas un à chaque ouverture (A10).
      // Un ajout l'écrira.
      const read = await readWorkspaceConfig(root);
      clients = read.mcpClients ?? [];
      scope = secretsScopeOf(read);
    } catch (e) {
      // Absent : aucun serveur déclaré. Illisible : le fichier reste tel quel, aucun serveur ne
      // démarre, et le projet s'ouvre quand même. L'interface l'a dit par `configIssue` ; un ajout le
      // redira.
      if (!(e instanceof WorkspaceConfigError)) throw e;
      if (e.kind !== 'absent') console.warn('[mcp-clients] config.json illisible, aucun serveur démarré:', e.message);
      return;
    }
    // Aucun serveur déclaré : rien à ranger, à demander ni à démarrer.
    if (superseded() || clients.length === 0) return;

    // Fusion 1.5: any sensitive env value still in plain text inside
    // `config.json` is migrated to `secureStorage` on first load. The
    // config is only rewritten when at least one secret was actually
    // moved, so opening a workspace with no secrets is a no-op.
    // La portée des secrets naît dans cette même écriture, avant le garde : pour ranger un secret,
    // ou pour recopier sous elle l'ancienne clé d'un projet déjà migré (S09-1-6). Si l'écriture
    // échoue, le projet reste sans portée, et l'ancienne clé sert toujours ; ce qui a été rangé sous
    // la portée née dans l'écriture est retiré, sans quoi chaque ouverture en laisserait une copie.
    // Appelée seulement s'il y a quelque chose à écrire : `updateWorkspaceConfig` crée les dossiers
    // de `.cliodeck` avant même le mutateur, et un projet reçu d'un tiers gagnait `recipes/` et
    // `recipes-runs/` avant la question, même refusée (A10).
    if (secretsMigrationDue(clients, scope)) {
      const unsaved: Array<{ scope: string; clients: WorkspaceClientConfig[] }> = [];
      try {
        const cfg = await updateWorkspaceConfig(root, (current) => {
          const declared = current.mcpClients ?? [];
          if (!declared.some(clientHasSecrets)) return false;
          let changed = secretsScopeOf(current) === null;
          const currentScope = ensureSecretsScope(current);
          if (changed) unsaved.push({ scope: currentScope, clients: declared });
          for (const w of declared) {
            if (migrateClientEnvSecrets(currentScope, w)) changed = true;
          }
          return changed ? undefined : false;
        });
        clients = cfg.mcpClients ?? [];
        scope = secretsScopeOf(cfg);
      } catch (e) {
        console.warn('[mcp-clients] failed to persist secret migration:', e);
        for (const { scope: lost, clients: stored } of unsaved) discardUnsavedScope(lost, stored);
      }
      if (superseded()) return;
    }

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
        manager.register(toManagerConfig(w, scope));
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
  private detach(): { manager: MCPClientManager | null; accessLog: AccessLog | null } {
    this.loadGeneration += 1;
    const detached = { manager: this.manager, accessLog: this.accessLog };
    this.manager = null;
    this.workspaceRoot = null;
    this.accessLog = null;
    return detached;
  }

  /**
   * Arrête les serveurs (attente bornée par le manager), puis ferme le journal, qui a reçu leurs
   * derniers événements.
   */
  private async release(detached: {
    manager: MCPClientManager | null;
    accessLog: AccessLog | null;
  }): Promise<void> {
    await detached.manager?.stopAll();
    detached.accessLog?.close();
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
    // Les secrets que cette tentative range, et sous quelle portée : si config.json ne s'écrit pas,
    // rien ne les nomme, et ils sont retirés.
    const stored: Array<{ scope: string; scopeCreated: boolean }> = [];
    // Ce que le manager inscrira, établi dans l'écriture : tout ce qui ferait lever register() est
    // refusé avant que config.json change (S09-1-3), et aucun slot n'existe tant qu'il n'est pas écrit.
    let registration: ManagerClientConfig | undefined;
    try {
      await updateWorkspaceConfig(root, (cfg) => {
        // Un autre projet ouvert pendant l'attente du verrou ou la lecture : rien n'est écrit.
        if (this.manager !== manager) throw projectChanged();
        const existing = cfg.mcpClients ?? [];
        if (existing.some((c) => c.name === client.name)) {
          throw new Error(`MCP client "${client.name}" already exists`);
        }
        // Absent de config.json mais encore inscrit (le fichier retouché à la main, projet ouvert).
        if (manager.get(client.name)) {
          throw new Error(`MCP client "${client.name}" already registered`);
        }
        // Route fresh secrets straight to `secureStorage` so they never
        // touch `config.json`. The migration step above handles previously
        // persisted plain values; this catches new ones at the door.
        // Sous la portée du projet, créée dans cette écriture s'il n'en a pas (S09-1-6).
        if (clientHasSecrets(client)) {
          const scopeCreated = secretsScopeOf(cfg) === null;
          const scope = ensureSecretsScope(cfg);
          // Noté après les deux refus, jamais pour eux : la clé d'un client déclaré du même nom n'est
          // pas à cette tentative. Avant de ranger : un rangement interrompu se retire aussi.
          stored.push({ scope, scopeCreated });
          migrateClientEnvSecrets(scope, client);
        }
        // Lève pour un stdio sans commande ou un SSE sans adresse : rien n'est écrit.
        registration = toManagerConfig(client, secretsScopeOf(cfg));
        cfg.mcpClients = [...existing, client];
      });
    } catch (e) {
      for (const { scope, scopeCreated } of stored) {
        if (scopeCreated) {
          discardUnsavedScope(scope, [client]);
          continue;
        }
        // Portée déjà enregistrée : les secrets des autres clients servent, seuls ceux de ce nom
        // partent. Le nom est libre dans config.json (refus « already exists » plus haut) : rien
        // ne les relit.
        try {
          deleteClientEnvSecrets(scope, client);
        } catch (err) {
          console.warn('[mcp-clients] secrets d’un ajout non écrit impossibles à retirer:', err);
        }
      }
      throw e;
    }
    // Écrit : l'ajout est fait, dans le config.json de CE projet. Si un autre projet s'est ouvert
    // pendant l'écriture, pas de refus (il dirait que rien n'a été écrit), mais rien n'est inscrit
    // ni démarré dans le manager abandonné : le serveur démarrera avec les autres serveurs déclarés,
    // au prochain chargement de ce projet. (`registration` est établie dès que l'écriture a abouti.)
    if (this.manager !== manager || !registration) {
      return { name: client.name, state: 'unconfigured', tools: [], generation: 0 };
    }
    manager.register(registration);
    return manager.start(client.name);
  }

  async removeClient(name: string): Promise<void> {
    const root = this.workspaceRoot;
    const manager = this.manager;
    if (!root || !manager) {
      throw new Error('No project loaded');
    }
    let removed: WorkspaceClientConfig | undefined;
    const saved = await updateWorkspaceConfig(root, (cfg) => {
      // Un autre projet ouvert pendant l'attente du verrou ou la lecture : rien n'est écrit.
      if (this.manager !== manager) throw projectChanged();
      removed = (cfg.mcpClients ?? []).find((c) => c.name === name);
      cfg.mcpClients = (cfg.mcpClients ?? []).filter((c) => c.name !== name);
    });
    // Seule la clé de CE projet : l'ancienne clé globale peut servir à un autre (S09-1-6).
    const scope = secretsScopeOf(saved);
    if (removed && scope) deleteClientEnvSecrets(scope, removed);
    // Écrit : le retrait est fait. On retire le serveur de CE projet, sur le manager capturé — déjà
    // arrêté par la bascule si un autre projet s'est ouvert pendant l'écriture. Retiré, pas
    // seulement arrêté : la liste ne le montre plus, et son nom est libre pour un réajout (S09-1-3).
    await manager.unregister(name);
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
