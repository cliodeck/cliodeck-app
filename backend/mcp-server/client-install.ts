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
 * Nom de serveur accepté par Claude Code : lettres, chiffres, `-` et `_`.
 * Mesuré avec Claude Code 2.1 : « Invalid name Projet avec espaces. Names
 * can only contain letters, numbers, hyphens, and underscores. »
 */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Ramène un nom quelconque — le plus souvent celui du dossier du projet —
 * à un nom de serveur valide : diacritiques translittérés, espaces et
 * points changés en `-`, le reste retiré. « ARTICLE_Building our forge »
 * devient `ARTICLE_Building-our-forge`.
 *
 * Le même nom sert à Claude Desktop, qui accepterait n'importe quelle clé :
 * un projet doit porter le même nom dans les deux clients.
 */
export function mcpServerName(raw: string): string {
  const slug = raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\s.]+/g, '-')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return SERVER_NAME.test(slug) ? slug : 'cliodeck';
}

/**
 * Nom effectif du serveur d'un projet : le nom choisi dans le panneau s'il
 * y en a un, sinon celui du dossier — dans les deux cas rendu valide.
 */
export function resolveServerName(configured: unknown, workspaceRoot: string): string {
  const chosen =
    typeof configured === 'string' && configured.trim().length > 0
      ? configured.trim()
      : path.basename(workspaceRoot);
  return mcpServerName(chosen);
}

/**
 * Fusionne une entrée dans `mcpServers` sans toucher au reste.
 *
 * Le fichier appartient à une autre application et contient déjà, chez un
 * utilisateur réel, d'autres serveurs et d'autres clés de premier niveau
 * (`preferences`…). On réécrit donc l'objet entier tel qu'il était, la seule
 * différence étant l'entrée visée.
 *
 * Une entrée identique déclarée sous un autre nom est retirée : c'est le
 * même serveur, pour le même projet. Cas réel : un projet d'abord déclaré
 * « ARTICLE_Building our forge », puis `ARTICLE_Building-our-forge` une
 * fois le nom rendu valide — sans ce ménage, Claude Desktop lancerait deux
 * fois le même serveur.
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

  const serialized = JSON.stringify(entry);
  const before = servers[name];
  const same = !!before && typeof before === 'object' && JSON.stringify(before) === serialized;

  let removedTwin = false;
  for (const [other, value] of Object.entries(servers)) {
    if (other !== name && JSON.stringify(value) === serialized) {
      delete servers[other];
      removedTwin = true;
    }
  }

  servers[name] = entry;
  config.mcpServers = servers;

  const status: MergeStatus =
    same && !removedTwin ? 'unchanged' : before || removedTwin ? 'replaced' : 'added';
  return { config, status };
}

/** Un argument qui se passe de guillemets dans tous les shells visés. */
const BARE_ARGUMENT = /^[A-Za-z0-9_/.:=@+,-]+$/;

/**
 * Protège un argument pour le shell où la commande sera collée.
 *
 * macOS et Linux : guillemets **simples**, les seuls où rien n'est
 * interprété. Les guillemets doubles employés jusqu'ici laissaient le shell
 * développer `$`, `` ` `` et `!` : `"Budget $2026"` y devient `Budget `.
 *
 * Windows : guillemets doubles, compris par cmd.exe comme par PowerShell ;
 * un nom de fichier Windows ne peut pas contenir `"`.
 */
export function shellQuote(arg: string, platform: ClaudeDesktopPlatform): string {
  if (BARE_ARGUMENT.test(arg)) return arg;
  if (platform === 'win32') return `"${arg}"`;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Commande d'ajout pour Claude Code, à copier dans un terminal.
 *
 * Seule source de cette commande : le panneau en construisait une copie sans
 * aucun guillemet, qui découpait le chemin d'un projet à chaque espace.
 * Collée depuis un dossier OneDrive, elle enregistrait le serveur
 * `ARTICLE_Building` lancé par la commande `our`.
 */
export function claudeCodeCommand(
  name: string,
  entry: ServerEntry,
  platform: ClaudeDesktopPlatform
): string {
  const args = [entry.command, ...entry.args].map((a) => shellQuote(a, platform)).join(' ');
  return `claude mcp add ${shellQuote(mcpServerName(name), platform)} -- ${args}`;
}

/** Ligne de lancement du serveur, pour un client MCP quelconque. */
export function launchCommand(entry: ServerEntry, platform: ClaudeDesktopPlatform): string {
  return [entry.command, ...entry.args].map((a) => shellQuote(a, platform)).join(' ');
}
