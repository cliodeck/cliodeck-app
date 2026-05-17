/**
 * ObsidianVaultReader
 *
 * Scans an Obsidian vault directory for .md files, builds a directory tree,
 * and watches for changes via chokidar.
 */

import fs from 'fs';
import path from 'path';
import type { FSWatcher } from 'chokidar';
import type { VaultFileEntry, VaultTreeNode } from '../../types/vault.js';

type VaultEvent = 'file-added' | 'file-changed' | 'file-deleted';
type VaultEventCallback = (entry: VaultFileEntry) => void;

// Directories to always skip
const DEFAULT_IGNORE_DIRS = [
  '.obsidian',
  '.trash',
  '.git',
  '.cliobrain',
  'node_modules',
];

// File patterns to skip
const DEFAULT_IGNORE_PATTERNS = [
  /^\./,  // Hidden files
];

export class ObsidianVaultReader {
  private vaultPath: string;
  private ignorePatterns: string[];
  private entries: Map<string, VaultFileEntry> = new Map();
  private watcher: FSWatcher | null = null;
  private listeners: Map<VaultEvent, VaultEventCallback[]> = new Map();

  constructor(vaultPath: string, ignorePatterns: string[] = []) {
    this.vaultPath = path.resolve(vaultPath);
    this.ignorePatterns = ignorePatterns;

    if (!fs.existsSync(this.vaultPath)) {
      throw new Error(`Vault path does not exist: ${this.vaultPath}`);
    }

    if (!fs.statSync(this.vaultPath).isDirectory()) {
      throw new Error(`Vault path is not a directory: ${this.vaultPath}`);
    }
  }

  get path(): string {
    return this.vaultPath;
  }

  /**
   * Get the vault name (from .obsidian/app.json or folder name)
   */
  getVaultName(): string {
    try {
      const appJsonPath = path.join(this.vaultPath, '.obsidian', 'app.json');
      if (fs.existsSync(appJsonPath)) {
        // Obsidian stores the vault name implicitly as the folder name,
        // but we can check the folder name directly
      }
    } catch {
      // Ignore
    }
    return path.basename(this.vaultPath);
  }

  /**
   * Scan the vault directory for all .md files
   */
  async scan(): Promise<VaultFileEntry[]> {
    this.entries.clear();
    await this.scanDirectory('');
    return this.getAllEntries();
  }

  /**
   * Recursively scan a directory
   */
  private async scanDirectory(relativeDir: string): Promise<void> {
    const absoluteDir = path.join(this.vaultPath, relativeDir);
    let dirEntries: fs.Dirent[];

    try {
      dirEntries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return; // Skip unreadable directories
    }

    for (const entry of dirEntries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (this.shouldIgnoreDir(entry.name)) continue;
        await this.scanDirectory(relativePath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (this.shouldIgnoreFile(entry.name)) continue;

        try {
          const absolutePath = path.join(this.vaultPath, relativePath);
          const stat = fs.statSync(absolutePath);

          const fileEntry: VaultFileEntry = {
            relativePath,
            absolutePath,
            fileName: entry.name,
            directory: relativeDir,
            mtime: stat.mtimeMs,
            size: stat.size,
          };

          this.entries.set(relativePath, fileEntry);
        } catch {
          // Skip files that can't be stat'd
        }
      }
    }
  }

  /**
   * Check if a directory should be ignored
   */
  private shouldIgnoreDir(name: string): boolean {
    if (DEFAULT_IGNORE_DIRS.includes(name)) return true;
    if (name.startsWith('.')) return true;
    return this.ignorePatterns.some(p => name === p || name.match(p));
  }

  /**
   * Check if a file should be ignored
   */
  private shouldIgnoreFile(name: string): boolean {
    return DEFAULT_IGNORE_PATTERNS.some(p => p.test(name));
  }

  /**
   * Read the content of a file
   */
  readFile(relativePath: string): string {
    const absolutePath = path.join(this.vaultPath, relativePath);
    return fs.readFileSync(absolutePath, 'utf-8');
  }

  /**
   * Start watching the vault for changes
   */
  async watch(): Promise<void> {
    if (this.watcher) return;

    // Dynamic import for chokidar (ESM)
    const chokidar = await import('chokidar');

    this.watcher = chokidar.watch('**/*.md', {
      cwd: this.vaultPath,
      ignored: [
        /(^|[/\\])\./,        // Hidden files/dirs
        '**/node_modules/**',
        '**/.obsidian/**',
        '**/.trash/**',
        '**/.cliobrain/**',
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.watcher.on('add', (relativePath: string) => {
      const entry = this.createEntry(relativePath);
      if (entry) {
        this.entries.set(relativePath, entry);
        this.emit('file-added', entry);
      }
    });

    this.watcher.on('change', (relativePath: string) => {
      const entry = this.createEntry(relativePath);
      if (entry) {
        this.entries.set(relativePath, entry);
        this.emit('file-changed', entry);
      }
    });

    this.watcher.on('unlink', (relativePath: string) => {
      const existing = this.entries.get(relativePath);
      if (existing) {
        this.entries.delete(relativePath);
        this.emit('file-deleted', existing);
      }
    });
  }

  /**
   * Stop watching
   */
  async unwatch(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Create a VaultFileEntry from a relative path
   */
  private createEntry(relativePath: string): VaultFileEntry | null {
    try {
      const absolutePath = path.join(this.vaultPath, relativePath);
      const stat = fs.statSync(absolutePath);
      return {
        relativePath,
        absolutePath,
        fileName: path.basename(relativePath),
        directory: path.dirname(relativePath),
        mtime: stat.mtimeMs,
        size: stat.size,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get a single entry by relative path
   */
  getEntry(relativePath: string): VaultFileEntry | undefined {
    return this.entries.get(relativePath);
  }

  /**
   * Get all scanned entries
   */
  getAllEntries(): VaultFileEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Build a nested directory tree for the UI
   */
  getTree(): VaultTreeNode[] {
    const root: VaultTreeNode[] = [];
    const dirs = new Map<string, VaultTreeNode>();

    // Sort entries for consistent tree order
    const sorted = this.getAllEntries().sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath)
    );

    for (const entry of sorted) {
      const parts = entry.relativePath.split('/');
      const fileName = parts.pop()!;

      // Ensure all parent directories exist in the tree
      let currentChildren = root;
      let currentPath = '';

      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;

        if (!dirs.has(currentPath)) {
          const dirNode: VaultTreeNode = {
            name: part,
            type: 'folder',
            relativePath: currentPath,
            children: [],
          };
          dirs.set(currentPath, dirNode);
          currentChildren.push(dirNode);
        }

        currentChildren = dirs.get(currentPath)!.children!;
      }

      // Add the file node
      currentChildren.push({
        name: fileName.replace(/\.md$/i, ''),
        type: 'file',
        relativePath: entry.relativePath,
      });
    }

    return root;
  }

  /**
   * Get the total number of .md files found
   */
  get fileCount(): number {
    return this.entries.size;
  }

  /**
   * Register an event listener
   */
  on(event: VaultEvent, callback: VaultEventCallback): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  /**
   * Emit an event
   */
  private emit(event: VaultEvent, entry: VaultFileEntry): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(entry);
        } catch (e) {
          console.error(`[VaultReader] Event handler error for ${event}:`, e);
        }
      }
    }
  }

  /**
   * Cleanup
   */
  async destroy(): Promise<void> {
    await this.unwatch();
    this.entries.clear();
    this.listeners.clear();
  }
}
