/**
 * Déclaration du serveur MCP d'un projet auprès des clients qui le liront.
 *
 * Deux clients, deux mécaniques, et le découpage se fait par **client**, pas
 * par système :
 *
 *   - **Claude Desktop** (macOS et Windows uniquement) lit
 *     `claude_desktop_config.json`. C'est la voie multi-projets : chaque
 *     projet y est une entrée nommée, et plusieurs peuvent coexister.
 *     L'extension `.mcpb` est plus simple à installer mais ne porte qu'un
 *     seul jeu de réglages, donc un seul projet.
 *   - **Claude Code** (tous systèmes, Linux compris, où Claude Desktop
 *     n'existe pas) se configure par une commande `claude mcp add`.
 *
 * Les fonctions ici sont pures et sans Electron pour rester testables : le
 * handler IPC s'occupe du disque, de la sauvegarde et des permissions.
 */

import path from 'path';

export type ClaudeDesktopPlatform = 'darwin' | 'win32' | 'linux';

export interface ServerEntry {
  command: string;
  args: string[];
}

export type MergeStatus = 'added' | 'replaced' | 'unchanged';

export interface MergeResult {
  /** Configuration complète à réécrire — toutes les autres clés conservées. */
  config: Record<string, unknown>;
  status: MergeStatus;
}

/**
 * Emplacement de `claude_desktop_config.json`, ou `null` là où Claude
 * Desktop n'existe pas. Retourner `null` pour Linux est le point important :
 * y écrire le fichier produirait une configuration que rien ne lit jamais.
 */
export function claudeDesktopConfigPath(
  platform: ClaudeDesktopPlatform,
  env: { home?: string; appData?: string }
): string | null {
  switch (platform) {
    case 'darwin':
      return env.home
        ? path.join(env.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : null;
    case 'win32':
      return env.appData
        ? path.join(env.appData, 'Claude', 'claude_desktop_config.json')
        : null;
    case 'linux':
      return null;
  }
}

/**
 * Fusionne une entrée dans `mcpServers` sans toucher au reste.
 *
 * Le fichier appartient à une autre application et contient déjà, chez un
 * utilisateur réel, d'autres serveurs et d'autres clés de premier niveau
 * (`preferences`…). On réécrit donc l'objet entier tel qu'il était, la seule
 * différence étant l'entrée visée.
 */
export function mergeServerEntry(
  existing: Record<string, unknown> | null,
  name: string,
  entry: ServerEntry
): MergeResult {
  const config: Record<string, unknown> = { ...(existing ?? {}) };
  const servers: Record<string, unknown> = {
    ...((config.mcpServers as Record<string, unknown> | undefined) ?? {}),
  };

  const before = servers[name];
  const same =
    !!before &&
    typeof before === 'object' &&
    JSON.stringify(before) === JSON.stringify(entry);

  servers[name] = entry;
  config.mcpServers = servers;

  return { config, status: same ? 'unchanged' : before ? 'replaced' : 'added' };
}

/** Commande d'ajout pour Claude Code, à copier dans un terminal. */
export function claudeCodeCommand(name: string, entry: ServerEntry): string {
  const quote = (s: string): string => (/[\s"']/.test(s) ? JSON.stringify(s) : s);
  return `claude mcp add ${quote(name)} -- ${quote(entry.command)} ${entry.args.map(quote).join(' ')}`;
}
