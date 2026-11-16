/**
 * Environment filter for MCP stdio subprocesses.
 *
 * A malicious or misconfigured client config could inject loader-hijack
 * variables (LD_PRELOAD, DYLD_INSERT_LIBRARIES), Node/Python preload hooks
 * (NODE_OPTIONS, PYTHONSTARTUP), or lookup-path overrides (PATH, PYTHONPATH)
 * that would execute arbitrary code inside the spawned process.
 *
 * Strategy: build a base env from a fixed whitelist of safe variables taken
 * from the parent process environment, then overlay user-supplied env on top
 * *after* stripping any denylisted key. The denylist wins over the whitelist.
 * PATH is not denylisted: a client config may declare its own PATH (a runtime
 * installed by nvm or pyenv), which then replaces the inherited one. The
 * approval fingerprint covers the declared env, values included, and the
 * dialog shows a declared PATH (`fingerprintClient`, `confirmMcpAdd`).
 *
 * The parent env is `mcpSpawnParentEnv()`: the process env with a completed
 * PATH, since an app launched from the Dock only gets launchd's (S09-1-10).
 *
 * Exported separately to allow unit testing without spawning subprocesses.
 */

import os from 'os';
import path from 'path';
import { readdirSync } from 'fs';
import { extendedToolPath } from '../../core/tools/external-tools.js';

/** Variables safely inherited from the parent process, by prefix or exact name. */
const INHERIT_ALLOW_EXACT: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'LANG',
  'LANGUAGE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'COMSPEC',
  'WINDIR',
  'SHELL',
  'TERM',
]);

const INHERIT_ALLOW_PREFIX: readonly string[] = ['LC_', 'XDG_'];

/**
 * Keys that must never appear in the final env, regardless of source.
 * Exact matches and prefix matches.
 */
const DENY_EXACT: ReadonlySet<string> = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'PERL5LIB',
  'PERL5OPT',
  'RUBYOPT',
  'RUBYLIB',
]);

const DENY_PREFIX: readonly string[] = ['DYLD_'];

function isDenied(key: string): boolean {
  if (DENY_EXACT.has(key)) return true;
  for (const p of DENY_PREFIX) {
    if (key.startsWith(p)) return true;
  }
  return false;
}

function isInheritable(key: string): boolean {
  if (INHERIT_ALLOW_EXACT.has(key)) return true;
  for (const p of INHERIT_ALLOW_PREFIX) {
    if (key.startsWith(p)) return true;
  }
  return false;
}

/**
 * Build a sanitized env for spawning an MCP subprocess.
 *
 * @param userEnv user-supplied env from the MCP client config (may be undefined)
 * @param parentEnv parent process env (defaults to `process.env`)
 */
export function buildMCPSpawnEnv(
  userEnv: Record<string, string> | undefined,
  parentEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const out: Record<string, string> = {};

  // Step 1: inherit whitelisted vars from parent.
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined) continue;
    if (!isInheritable(k)) continue;
    if (isDenied(k)) continue;
    out[k] = v;
  }

  // Step 2: overlay user env, minus denylisted keys.
  if (userEnv) {
    for (const [k, v] of Object.entries(userEnv)) {
      if (isDenied(k)) continue;
      out[k] = v;
    }
  }

  return out;
}

/** Comme pour `sort`, sur `[majeur, mineur, correctif]`. */
function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * `~/.nvm/versions/node/<version>/bin` de la version la plus haute, comparée par numéros : par
 * ordre alphabétique, `v9.11.2` passerait après `v22.12.0`. L'alias `default` de nvm n'est pas
 * lu (`lts/*`, `22`, `node` : ce serait refaire nvm) ; un client qui veut une autre version
 * déclare son PATH.
 */
function latestNvmBin(versionsDir: string, readdir: (dir: string) => string[]): string | null {
  let entries: string[];
  try {
    entries = readdir(versionsDir);
  } catch {
    return null; // pas de nvm, ou dossier illisible
  }
  let best: { name: string; parts: number[] } | null = null;
  for (const name of entries) {
    const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(name);
    if (!m) continue;
    const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || compareVersions(parts, best.parts) > 0) best = { name, parts };
  }
  return best ? path.join(versionsDir, best.name, 'bin') : null;
}

/**
 * L'env parent d'un serveur MCP stdio : celui du processus, PATH complété.
 *
 * Lancée depuis le Dock ou le Finder, l'app reçoit le PATH de launchd
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) : `npx`, `node` et `uvx`, les commandes nues que le garde
 * d'ajout accepte, y échouaient en « spawn ENOENT » (S09-1-10). On y ajoute les emplacements des
 * exports (`extendedToolPath`) et, devant eux, ceux de uv (`~/.local/bin`), de Volta et de la
 * version de nvm la plus haute. Sous Windows, rien ne change.
 *
 * Si le PATH hérité contient déjà une version de nvm (app lancée d'un terminal après
 * `nvm use 20`), aucune autre n'est ajoutée : la plus haute passerait devant le choix fait.
 *
 * Ce PATH ne sert qu'au lancement : il n'entre ni dans `config.json` ni dans l'empreinte
 * d'accord, qui ne couvre que l'env déclaré par le client.
 */
export function mcpSpawnParentEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
  deps: { home?: string; platform?: NodeJS.Platform; readdir?: (dir: string) => string[] } = {}
): NodeJS.ProcessEnv {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return parentEnv;
  const home = deps.home ?? os.homedir();
  const readdir = deps.readdir ?? ((dir: string) => readdirSync(dir));
  const inherited = parentEnv.PATH ?? '';
  // Un HOME vide ou relatif donnerait des dossiers cherchés depuis le dossier courant.
  const userDirs: string[] = [];
  if (path.isAbsolute(home)) {
    userDirs.push(path.join(home, '.local', 'bin'), path.join(home, '.volta', 'bin'));
    const nvmVersions = path.join(home, '.nvm', 'versions', 'node');
    const nvmChosen = inherited
      .split(path.delimiter)
      .some((dir) => dir.startsWith(nvmVersions + path.sep));
    const nvm = nvmChosen ? null : latestNvmBin(nvmVersions, readdir);
    if (nvm) userDirs.push(nvm);
  }
  return { ...parentEnv, PATH: extendedToolPath(inherited, platform, userDirs) };
}
