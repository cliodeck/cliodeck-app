/**
 * Garde appliqué aux serveurs MCP déclarés dans `.cliodeck/config.json`.
 *
 * Même dispositif que pour l'ajout manuel (`fusion:mcp:add`) : validation de
 * la commande et de l'environnement, puis confirmation native. La différence
 * est qu'ici l'accord est mémorisé par empreinte, sinon ouvrir son propre
 * projet redemanderait l'autorisation à chaque démarrage.
 */
import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import {
  appendMcpAudit,
  confirmMcpAdd,
  validateMcpAddRequest,
  type McpAddRequest,
} from '../ipc/handlers/mcp-add-guard.js';
import { workspaceFiles } from '../../../backend/core/workspace/layout.js';
import type { MCPClientConfig as WorkspaceClientConfig } from '../../../backend/core/workspace/config.js';
import {
  McpApprovalRegistry,
  fingerprintClient,
} from './mcp-approval-registry.js';

export type ApprovalVerdict = 'approved' | 'rejected' | 'invalid';

let registry: McpApprovalRegistry | null = null;

/** Registre partagé, hors de tout workspace (répertoire utilisateur). */
function getRegistry(): McpApprovalRegistry {
  if (!registry) {
    registry = new McpApprovalRegistry(
      path.join(app.getPath('userData'), 'mcp-approvals.json')
    );
  }
  return registry;
}

function toAddRequest(client: WorkspaceClientConfig): McpAddRequest {
  return {
    name: client.name,
    transport: client.transport,
    command: client.command,
    args: client.args,
    env: client.env,
    url: client.url,
  };
}

export async function defaultMcpApprovalGate(
  client: WorkspaceClientConfig,
  root: string
): Promise<ApprovalVerdict> {
  const req = toAddRequest(client);
  const auditPath = workspaceFiles(root).mcpAccessLog;

  const validation = validateMcpAddRequest(req);
  if (validation.ok !== true) {
    const why = 'reason' in validation ? validation.reason : 'unknown';
    await appendMcpAudit(auditPath, {
      ts: new Date().toISOString(),
      kind: 'mcp_add',
      decision: 'rejected',
      name: client.name,
      transport: client.transport,
      command: client.command,
      reason: `workspace_load:${why}`,
    });
    return 'invalid';
  }

  // SSE ne lance aucun processus : le garde d'ajout le laisse déjà passer.
  if (client.transport !== 'stdio') return 'approved';

  const fingerprint = fingerprintClient(client);
  const reg = getRegistry();
  if (await reg.isApproved(fingerprint)) return 'approved';

  const accepted = await confirmMcpAdd(req, {
    dialog,
    parentWindow: BrowserWindow.getFocusedWindow(),
  });

  await appendMcpAudit(auditPath, {
    ts: new Date().toISOString(),
    kind: 'mcp_add',
    decision: accepted ? 'accepted' : 'rejected',
    name: client.name,
    transport: client.transport,
    command: client.command,
    reason: 'workspace_load',
  });

  if (!accepted) return 'rejected';

  await reg.approve(fingerprint, client);
  return 'approved';
}
