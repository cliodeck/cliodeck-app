/**
 * Real MCPClientHandle factory backed by @modelcontextprotocol/sdk.
 *
 * Bridges the `MCPClientConfig` shape the manager expects to the SDK's
 * `Client` + `StdioClientTransport` / `SSEClientTransport`. Handles:
 *   - transport lifecycle (spawn subprocess, close pipes, abort SSE)
 *   - typed error mapping to the manager's `MCPClientError`
 *   - onCrash subscription so the manager can trigger its one silent retry
 *   - pagination of `tools/list`, bounded (`MAX_TOOL_PAGES`, cursor already seen)
 *
 * The manager owns state transitions; the factory is transport-dumb.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type {
  MCPClientConfig,
  MCPClientError,
  MCPToolDescriptor,
} from './types.js';
import type { MCPClientHandle, MCPClientFactory } from './manager.js';
import { buildMCPSpawnEnv, mcpSpawnParentEnv } from './env-filter.js';

const CLIENT_INFO = { name: 'cliodeck', version: '2.0.0' };

/**
 * Pages de `tools/list` lues au plus : un serveur qui renvoie toujours un curseur neuf ne retient pas
 * la connexion. Chaque page a le délai du SDK (60 s).
 */
const MAX_TOOL_PAGES = 20;
/** Lignes écartées signalées par handle ; une dernière dit que les suivantes sont tues. */
const MAX_NOISE_WARNINGS = 5;
/** Longueur gardée de l'erreur : un serveur peut écrire son env, clés comprises, sur sa sortie. */
const NOISE_EXCERPT_CHARS = 100;

function now(): string {
  return new Date().toISOString();
}

/**
 * Une ligne de la sortie (stdio) ou un événement (SSE) qui n'est pas un message JSON-RPC : le
 * transport l'écarte, le signale par `onerror` et continue de lire. `SyntaxError` de `JSON.parse`,
 * `ZodError` du schéma du SDK. Tout le reste (spawn, EPIPE, `SseError`) est un plantage.
 */
function isLineNoise(err: unknown): boolean {
  return err instanceof SyntaxError || (err instanceof Error && err.name === 'ZodError');
}

function excerpt(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > NOISE_EXCERPT_CHARS ? `${flat.slice(0, NOISE_EXCERPT_CHARS)}…` : flat;
}

function toErr(code: string, e: unknown): MCPClientError {
  return {
    code,
    message: e instanceof Error ? e.message : String(e),
    at: now(),
  };
}

export const realMCPClientFactory: MCPClientFactory = (
  cfg: MCPClientConfig
): MCPClientHandle => {
  let client: Client | null = null;
  let transport: StdioClientTransport | SSEClientTransport | null = null;
  const crashCallbacks: Array<(err: MCPClientError) => void> = [];
  let crashed = false;
  let noiseLines = 0;

  const fireCrash = (err: MCPClientError): void => {
    if (crashed) return;
    crashed = true;
    crashCallbacks.forEach((cb) => {
      try {
        cb(err);
      } catch {
        // ignore subscriber throws
      }
    });
  };

  // Une bannière ou un print de débogage n'est pas un plantage : le serveur était abattu et relancé
  // à chaque ligne (S09-2-0). L'avertissement est borné et ne recopie jamais la ligne entière.
  const onTransportError = (err: Error): void => {
    if (!isLineNoise(err)) {
      fireCrash(toErr('transport_error', err));
      return;
    }
    noiseLines += 1;
    if (noiseLines <= MAX_NOISE_WARNINGS) {
      console.warn(`[mcp-clients] ${cfg.name} : ligne ignorée, pas du JSON-RPC (${excerpt(err.message)})`);
    } else if (noiseLines === MAX_NOISE_WARNINGS + 1) {
      console.warn(`[mcp-clients] ${cfg.name} : autres lignes ignorées, plus signalées`);
    }
  };

  return {
    async connect(): Promise<void> {
      if (cfg.config.transport === 'stdio') {
        const stdio = new StdioClientTransport({
          command: cfg.config.command,
          args: cfg.config.args ?? [],
          // PATH complété : depuis le Dock, celui de launchd ne trouve ni npx, ni node, ni uvx
          // (S09-1-10). Un PATH déclaré par le client reste prioritaire.
          env: buildMCPSpawnEnv(cfg.config.env, mcpSpawnParentEnv()),
          cwd: cfg.config.cwd,
        });
        stdio.onerror = onTransportError;
        stdio.onclose = (): void =>
          fireCrash(toErr('transport_closed', 'stdio transport closed'));
        transport = stdio;
      } else {
        const sse = new SSEClientTransport(new URL(cfg.config.url), {
          requestInit: cfg.config.headers
            ? { headers: cfg.config.headers }
            : undefined,
        });
        sse.onerror = onTransportError;
        sse.onclose = (): void =>
          fireCrash(toErr('transport_closed', 'sse transport closed'));
        transport = sse;
      }

      client = new Client(CLIENT_INFO, {});
      await client.connect(transport);
    },

    async listTools(): Promise<MCPToolDescriptor[]> {
      // Capturé : fermé pendant la lecture, le client refuse la page suivante (« Not connected »).
      const connected = client;
      if (!connected) throw new Error('MCP client not connected');
      // Tout le catalogue, page après page (S09-2-5). Un curseur déjà vu ou le plafond arrêtent la
      // lecture sans faire échouer le serveur : les pages lues restent. Un outil déjà lu garde sa
      // première page.
      const tools = new Map<string, MCPToolDescriptor>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const res = await connected.listTools(cursor === undefined ? undefined : { cursor });
        for (const t of res.tools ?? []) {
          if (tools.has(t.name)) continue;
          tools.set(t.name, {
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown> | undefined,
          });
        }
        if (!res.nextCursor) return [...tools.values()];
        if (seenCursors.has(res.nextCursor)) {
          console.warn(`[mcp-clients] ${cfg.name} : curseur de tools/list déjà lu, catalogue arrêté à ${tools.size} outils`);
          return [...tools.values()];
        }
        seenCursors.add(res.nextCursor);
        cursor = res.nextCursor;
      }
      console.warn(`[mcp-clients] ${cfg.name} : tools/list arrêté après ${MAX_TOOL_PAGES} pages, à ${tools.size} outils`);
      return [...tools.values()];
    },

    async callTool(name, args) {
      if (!client) {
        return {
          ok: false,
          error: toErr('client_not_connected', 'MCP client not connected'),
        };
      }
      try {
        const res = await client.callTool({ name, arguments: args });
        return { ok: !res.isError, result: res };
      } catch (e) {
        return { ok: false, error: toErr('call_tool_error', e) };
      }
    },

    async close(): Promise<void> {
      try {
        await client?.close();
      } catch {
        // best effort
      }
      try {
        await transport?.close();
      } catch {
        // best effort
      }
      client = null;
      transport = null;
    },

    onCrash(cb): void {
      crashCallbacks.push(cb);
    },
  };
};
