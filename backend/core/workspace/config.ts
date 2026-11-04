/**
 * Workspace config schema.
 *
 * `schema_version` is the canonical marker: any loader must refuse to operate
 * on a workspace whose `schema_version` is greater than its own compile-time
 * `WORKSPACE_SCHEMA_VERSION` (forward-compat is not implied). Unknown fields
 * are preserved on save so older clients don't silently strip new settings.
 */

import path from 'path';
import {
  atomicWriteFile,
  readUserFile,
  UnreadableFileError,
  updateFile,
  withFileLock,
} from '../fs/user-files.js';
import { ensureWorkspaceDirectories, workspaceFiles } from './layout.js';

export const WORKSPACE_SCHEMA_VERSION = 2 as const;

export interface MCPClientConfig {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface WorkspaceConfig {
  schema_version: 2;
  /** Human-readable workspace name. */
  name?: string;
  /** ISO timestamps for audit trail. */
  created_at?: string;
  updated_at?: string;
  /** LLM provider config; consumed by ProviderRegistry (1.3). */
  llm?: {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKey?: string;
  };
  embedding?: {
    provider: string;
    model: string;
    dimension: number;
    baseUrl?: string;
    apiKey?: string;
  };
  /** External MCP servers the workspace can consume (phase 4.4). */
  mcpClients?: MCPClientConfig[];
  /** Source-inspector defence policy (phase 4.5). Optional — absent means
   * default `warn`. Stored per-workspace so the choice survives across
   * sessions and can vary by project (a corpus of public archives may
   * accept stricter `block`; one full of historical primary sources with
   * imperative speech may need `warn`). */
  security?: {
    sourceInspectorMode?: 'warn' | 'audit' | 'block';
  };
  /** Catch-all for forward-compat: unknown keys are preserved. */
  [k: string]: unknown;
}

export function defaultWorkspaceConfig(name?: string): WorkspaceConfig {
  const now = new Date().toISOString();
  return {
    schema_version: WORKSPACE_SCHEMA_VERSION,
    name,
    created_at: now,
    updated_at: now,
  };
}

const CONFIG_LABEL = '.cliodeck/config.json';
const BOM = '\uFEFF';

/**
 * Le fichier ne se lit pas comme une configuration : surtout ne pas le réécrire. Le coffre, les
 * serveurs MCP et le mode de sécurité y sont, et rien ne les restituerait. `absent` est le seul
 * cas où initialiser ; `kind` porte la distinction, `message` se lit tel quel par un historien.
 */
export class WorkspaceConfigError extends Error {
  readonly code = 'workspace_config_unreadable';
  readonly kind: 'absent' | 'invalid_json' | 'newer_schema' | 'unreadable';
  readonly filePath: string;

  constructor(kind: WorkspaceConfigError['kind'], filePath: string, message: string) {
    super(message);
    this.name = 'WorkspaceConfigError';
    this.kind = kind;
    this.filePath = filePath;
  }
}

/** Ce que `project:load` rend à l'interface quand `config.json` est là mais illisible. */
export interface WorkspaceConfigIssue {
  kind: Exclude<WorkspaceConfigError['kind'], 'absent'>;
  path: string;
}

function invalidConfig(filePath: string): WorkspaceConfigError {
  return new WorkspaceConfigError(
    'invalid_json',
    filePath,
    `${CONFIG_LABEL} ne se lit pas (une virgule en trop, par exemple) : ce fichier n'a pas été modifié. Corrigez-le, puis rouvrez le projet.`
  );
}

function unreadableConfig(filePath: string, detail: string): WorkspaceConfigError {
  return new WorkspaceConfigError(
    'unreadable',
    filePath,
    `${CONFIG_LABEL} n'a pas pu être lu : ce fichier n'a pas été modifié. Vérifiez qu'il est accessible. (${detail})`
  );
}

/**
 * Le BOM d'un éditeur Windows n'est pas une faute : `JSON.parse` le refuse, on le passe. Rend
 * `null` pour 0 octet ou des blancs : c'est ce qu'ont laissé les écritures d'avant, qui n'étaient
 * pas atomiques, et il n'y a rien à préserver. Une version inférieure ou absente est acceptée,
 * champs conservés : seul le supérieur se refuse. Une version en texte se lit comme un nombre.
 */
function parseWorkspaceConfig(filePath: string, raw: string): WorkspaceConfig | null {
  if (raw.trim() === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.startsWith(BOM) ? raw.slice(BOM.length) : raw);
  } catch {
    throw invalidConfig(filePath);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidConfig(filePath);

  const stored = parsed as Record<string, unknown>;
  const version = stored.schema_version;
  if (version !== undefined) {
    const numeric = typeof version === 'string' && version.trim() !== '' ? Number(version) : version;
    if (typeof numeric !== 'number' || Number.isNaN(numeric)) throw invalidConfig(filePath);
    if (numeric > WORKSPACE_SCHEMA_VERSION) {
      throw new WorkspaceConfigError(
        'newer_schema',
        filePath,
        `${CONFIG_LABEL} vient d'une version plus récente de ClioDeck (format ${numeric}) : ce fichier n'a pas été modifié. Mettez ClioDeck à jour.`
      );
    }
  }
  return { ...stored, schema_version: WORKSPACE_SCHEMA_VERSION };
}

export async function readWorkspaceConfig(workspaceRoot: string): Promise<WorkspaceConfig> {
  const file = workspaceFiles(workspaceRoot).config;
  // Le verrou : une lecture demandée après une écriture lit ce que celle-ci a écrit.
  const read = await withFileLock(file, () => readUserFile(file));
  if (read.kind === 'unreadable') throw unreadableConfig(file, read.message);

  const cfg = read.kind === 'ok' ? parseWorkspaceConfig(file, read.content) : null;
  if (!cfg) throw new WorkspaceConfigError('absent', file, `${CONFIG_LABEL} est absent.`);
  return cfg;
}

/** Initialise sur un fichier absent, et seulement là : tout le reste lève, fichier intact. */
export function readOrInitWorkspaceConfig(workspaceRoot: string, name?: string): Promise<WorkspaceConfig> {
  return withFileLock(workspaceFiles(workspaceRoot).config, async () => {
    await ensureWorkspaceDirectories(workspaceRoot);
    try {
      return await readWorkspaceConfig(workspaceRoot);
    } catch (error) {
      if (!(error instanceof WorkspaceConfigError) || error.kind !== 'absent') throw error;
    }
    const fresh = defaultWorkspaceConfig(name ?? path.basename(workspaceRoot));
    await writeWorkspaceConfig(workspaceRoot, fresh);
    return fresh;
  });
}

function serializeWorkspaceConfig(cfg: WorkspaceConfig): string {
  const toWrite: WorkspaceConfig = {
    ...cfg,
    schema_version: WORKSPACE_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
  };
  return JSON.stringify(toWrite, null, 2);
}

/**
 * Remplace le fichier entier, sans le lire : pour ce qui n'a rien à y garder (une génération, une
 * migration explicite). Pour changer un champ, `updateWorkspaceConfig`.
 */
export async function writeWorkspaceConfig(
  workspaceRoot: string,
  cfg: WorkspaceConfig
): Promise<void> {
  await atomicWriteFile(workspaceFiles(workspaceRoot).config, serializeWorkspaceConfig(cfg));
}

/**
 * Lecture, mutation et écriture atomique sous le verrou du fichier : aucune mise à jour ne perd
 * celle d'à côté. Un fichier absent part de la configuration par défaut ; un fichier illisible
 * lève `WorkspaceConfigError` sans appeler `mutate`. Rendre `false` n'écrit rien. Le BOM reste,
 * comme pour un document : le fichier revient tel qu'il était.
 *
 * Le mutateur reste court : rien de long sous le verrou, ni indexation ni démarrage d'un serveur.
 */
export function updateWorkspaceConfig(
  workspaceRoot: string,
  mutate: (cfg: WorkspaceConfig) => void | false | Promise<void | false>
): Promise<WorkspaceConfig> {
  const file = workspaceFiles(workspaceRoot).config;
  return withFileLock(file, async () => {
    await ensureWorkspaceDirectories(workspaceRoot);
    let cfg = defaultWorkspaceConfig(path.basename(workspaceRoot));
    try {
      await updateFile(file, async (current) => {
        cfg = (current === null ? null : parseWorkspaceConfig(file, current)) ?? cfg;
        if ((await mutate(cfg)) === false) return null;
        const bom = current?.startsWith(BOM) ? BOM : '';
        return `${bom}${serializeWorkspaceConfig(cfg)}`;
      });
    } catch (error) {
      if (error instanceof UnreadableFileError) throw unreadableConfig(file, error.message);
      throw error;
    }
    return cfg;
  });
}

/** `null` si le fichier se lit, ou s'il n'est pas là : c'est à l'ouverture qu'on le demande. */
export async function workspaceConfigIssue(workspaceRoot: string): Promise<WorkspaceConfigIssue | null> {
  try {
    await readWorkspaceConfig(workspaceRoot);
    return null;
  } catch (error) {
    if (!(error instanceof WorkspaceConfigError)) throw error;
    return error.kind === 'absent' ? null : { kind: error.kind, path: error.filePath };
  }
}
