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
 * Les fonctions ici sont sans Electron pour rester testables. Seule
 * `installClaudeDesktopEntry` touche au disque, à un chemin reçu en argument ;
 * le handler IPC calcule ce chemin.
 */

import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { atomicWriteFile, parseUserJson, readUserFile } from '../core/fs/user-files.js';

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** La part de ClioDeck dans une entrée : la commande et ses arguments, rien d'autre. */
function launchesSame(value: unknown, entry: ServerEntry): value is Record<string, unknown> {
  return (
    isPlainObject(value) &&
    value.command === entry.command &&
    JSON.stringify(value.args) === JSON.stringify(entry.args)
  );
}

/**
 * Fusionne une entrée dans `mcpServers` sans toucher au reste.
 *
 * Le fichier appartient à une autre application et contient déjà, chez un
 * utilisateur réel, d'autres serveurs et d'autres clés de premier niveau
 * (`preferences`…). On réécrit donc l'objet entier tel qu'il était, la seule
 * différence étant l'entrée visée.
 *
 * Dans l'entrée elle-même, ClioDeck ne pose que `command` et `args` : le reste
 * est à l'utilisateur, et reste. L'interface lui demande d'y ajouter
 * `EUROPEANA_API_KEY` (`mcpHint`) ; remplacer l'entrée l'effaçait (S10-1-36).
 *
 * Une entrée qui lance la même commande sous un autre nom est retirée : c'est
 * le même serveur, pour le même projet, et son `env` passe à l'entrée gardée
 * si celle-ci n'en a pas. Cas réel : un projet d'abord déclaré
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

  const before = servers[name];
  const same = launchesSame(before, entry);

  let removedTwin = false;
  let twinEnv: unknown;
  for (const [other, value] of Object.entries(servers)) {
    if (other !== name && launchesSame(value, entry)) {
      twinEnv ??= value.env;
      delete servers[other];
      removedTwin = true;
    }
  }

  const merged: Record<string, unknown> = { ...(isPlainObject(before) ? before : {}), ...entry };
  if (merged.env === undefined && twinEnv !== undefined) merged.env = twinEnv;
  servers[name] = merged;
  config.mcpServers = servers;

  const status: MergeStatus =
    same && !removedTwin ? 'unchanged' : before || removedTwin ? 'replaced' : 'added';
  return { config, status };
}

export interface InstallResult {
  status: MergeStatus;
  /** La copie déposée à côté avant d'écrire, ou `null` : rien à copier, ou rien d'écrit. */
  backupPath: string | null;
}

/**
 * Copie de ce qu'on a lu, sous un nom qui n'écrase jamais une copie précédente : la copie
 * `.bak` unique était réécrite à chaque clic, et au deuxième, la version qui portait la clé
 * ajoutée à la main était perdue (S10-1-36). `:` est interdit dans un nom de fichier Windows.
 * Lisible du seul utilisateur : la copie porte les clés que l'entrée contient.
 */
async function writeBackup(target: string, content: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let n = 0; ; n++) {
    const candidate = `${target}.${stamp}${n === 0 ? '' : `-${n}`}.bak`;
    try {
      await writeFile(candidate, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/**
 * Écrit l'entrée d'un projet dans `claude_desktop_config.json` (chemin `target`).
 *
 * Un fichier qui ne se lit pas comme une configuration (JSON invalide, autre chose qu'un objet,
 * `mcpServers` qui n'en est pas un, pas en UTF-8) n'est jamais écrasé : l'erreur nomme le
 * fichier, et l'utilisateur décide. Sans changement, rien n'est écrit ni copié ; sinon, une copie
 * horodatée de la version lue, puis une écriture atomique.
 */
export async function installClaudeDesktopEntry(
  target: string,
  name: string,
  entry: ServerEntry
): Promise<InstallResult> {
  const read = await readUserFile(target);
  if (read.kind === 'unreadable') {
    throw new Error(`${target} n'a pas pu être lu ; corrigez-le avant de continuer. (${read.message})`);
  }

  let existing: Record<string, unknown> | null = null;
  if (read.kind === 'ok') {
    let parsed: unknown;
    try {
      parsed = parseUserJson(read.content);
    } catch {
      parsed = undefined;
    }
    // `mcpServers` qui n'est pas un objet : la fusion le remplacerait, serveurs de l'utilisateur compris.
    if (!isPlainObject(parsed) || (parsed.mcpServers !== undefined && !isPlainObject(parsed.mcpServers))) {
      throw new Error(`${target} n'est pas un JSON valide ; corrigez-le avant de continuer.`);
    }
    existing = parsed;
  }

  const { config, status } = mergeServerEntry(existing, name, entry);
  if (status === 'unchanged') return { status, backupPath: null };

  let backupPath: string | null = null;
  if (read.kind === 'ok') backupPath = await writeBackup(target, read.content);
  else await mkdir(path.dirname(target), { recursive: true });
  await atomicWriteFile(target, `${JSON.stringify(config, null, 2)}\n`);
  return { status, backupPath };
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
