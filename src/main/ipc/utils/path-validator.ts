/**
 * Path validation utilities for filesystem IPC handlers.
 * Prevents path traversal attacks and restricts file access scope.
 */
import path from 'path';
import os from 'os';

// Lazy import to avoid circular dependencies
let _projectManager: { getCurrentProjectPath: () => string | null } | null = null;

async function getProjectManager() {
  if (!_projectManager) {
    const mod = await import('../../services/project-manager.js');
    _projectManager = mod.projectManager;
  }
  return _projectManager;
}

/**
 * Validates a file path for read operations.
 * Read access is allowed within the user's home directory.
 * This is permissive to allow importing BibTeX, PDF, CSL files from anywhere in ~.
 */
export async function validateReadPath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const homeDir = os.homedir();

  // Allow reads within the home directory
  if (resolved.startsWith(homeDir)) {
    return resolved;
  }

  // Also allow common system paths for CSL styles, fonts, etc.
  const allowedSystemPrefixes = [
    '/usr/share',
    '/usr/local/share',
    '/opt/homebrew',
  ];
  for (const prefix of allowedSystemPrefixes) {
    if (resolved.startsWith(prefix)) {
      return resolved;
    }
  }

  throw new Error(`Read access denied: ${resolved} is outside allowed directories.`);
}

/**
 * Validates a file path for write operations.
 * Write access is restricted to the current project directory and home directory.
 */
export async function validateWritePath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const homeDir = os.homedir();
  const pm = await getProjectManager();
  const projectPath = pm.getCurrentProjectPath();

  // Allow writes within the project directory
  if (projectPath && resolved.startsWith(path.resolve(projectPath))) {
    return resolved;
  }

  // Allow writes within the home directory (for export, save-as, etc.)
  if (resolved.startsWith(homeDir)) {
    return resolved;
  }

  throw new Error(`Write access denied: ${resolved} is outside the project and home directories.`);
}
