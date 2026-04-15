/**
 * Path validation utilities for filesystem IPC handlers.
 *
 * Security model (hardened):
 *   - Reads are allowed only within the current project path (incl. `.cliodeck/`)
 *     and read-only packaged application resources.
 *   - Writes are allowed only within the current project path.
 *   - Symlinks escaping the allowed perimeter are rejected (realpath re-check).
 *   - Blanket `$HOME` access is REFUSED. A compromised renderer must not be
 *     able to touch `~/.ssh`, `~/.bashrc`, git credentials, etc.
 *
 * User-initiated filesystem operations outside the project (e.g. Save-As,
 * import from Documents) MUST go through a dedicated IPC route that obtains
 * explicit user consent via a native dialog — not through this generic
 * validator.
 */
import path from 'path';
import { realpath } from 'fs/promises';

// Lazy import to avoid circular dependencies
let _projectManager: { getCurrentProjectPath: () => string | null } | null = null;

async function getProjectManager() {
  if (!_projectManager) {
    const mod = await import('../../services/project-manager.js');
    _projectManager = mod.projectManager;
  }
  return _projectManager;
}

// Lazy import of electron.app so unit tests can run without electron runtime.
async function getAppResourceRoots(): Promise<string[]> {
  try {
    const electron = await import('electron');
    const app = (electron as any).app ?? (electron as any).default?.app;
    const roots: string[] = [];
    if (app && typeof app.getAppPath === 'function') {
      roots.push(path.resolve(app.getAppPath()));
    }
    // In packaged builds, resources live here.
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) {
      roots.push(path.resolve(resourcesPath));
    }
    return roots;
  } catch {
    return [];
  }
}

/**
 * Returns true if `child` is equal to, or nested within, `parent`.
 * Uses path segment boundary so `/a/b` does not match `/a/bc`.
 */
function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function projectRoots(): Promise<string[]> {
  const pm = await getProjectManager();
  const projectPath = pm.getCurrentProjectPath();
  if (!projectPath) return [];
  return [path.resolve(projectPath)];
}

/**
 * Resolve symlinks and re-check that the real path is still inside an allowed
 * root. If the file does not exist yet (write case), we fall back to resolving
 * the closest existing ancestor.
 */
async function realpathWithFallback(resolved: string): Promise<string> {
  try {
    return await realpath(resolved);
  } catch {
    // Walk up until we find an existing ancestor, then append the remainder.
    let current = resolved;
    const segments: string[] = [];
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) return resolved; // no existing ancestor
      try {
        const real = await realpath(parent);
        return path.join(real, ...segments.reverse());
      } catch {
        segments.push(path.basename(current));
        current = parent;
      }
    }
  }
}

/**
 * Validates a file path for read operations.
 * Allowed: current project tree (incl. `.cliodeck/`), packaged app resources.
 */
export async function validateReadPath(filePath: string): Promise<string> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Read access denied: empty path.');
  }
  const resolved = path.resolve(filePath);
  const allowedRoots = [...(await projectRoots()), ...(await getAppResourceRoots())];

  const withinLexical = allowedRoots.some((root) => isWithin(resolved, root));
  if (!withinLexical) {
    throw new Error(`Read access denied: ${resolved} is outside allowed directories.`);
  }

  // Symlink escape check.
  const real = await realpathWithFallback(resolved);
  const withinReal = allowedRoots.some((root) => isWithin(real, root));
  if (!withinReal) {
    throw new Error(`Read access denied: ${resolved} resolves outside allowed directories.`);
  }

  return resolved;
}

/**
 * Validates a file path for write operations.
 * Allowed: current project tree only. Packaged app resources are NEVER writable.
 */
export async function validateWritePath(filePath: string): Promise<string> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Write access denied: empty path.');
  }
  const resolved = path.resolve(filePath);
  const allowedRoots = await projectRoots();
  if (allowedRoots.length === 0) {
    throw new Error('Write access denied: no project is currently open.');
  }

  const withinLexical = allowedRoots.some((root) => isWithin(resolved, root));
  if (!withinLexical) {
    throw new Error(`Write access denied: ${resolved} is outside the project directory.`);
  }

  const real = await realpathWithFallback(resolved);
  const withinReal = allowedRoots.some((root) => isWithin(real, root));
  if (!withinReal) {
    throw new Error(`Write access denied: ${resolved} resolves outside the project directory.`);
  }

  return resolved;
}
