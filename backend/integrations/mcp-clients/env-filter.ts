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
 * *after* stripping any denylisted key. The denylist wins over the whitelist
 * — keys like PATH are whitelisted for inheritance but cannot be overridden
 * to a user-controlled value (the parent process's PATH is preserved).
 *
 * Exported separately to allow unit testing without spawning subprocesses.
 */

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
