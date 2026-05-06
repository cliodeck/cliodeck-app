/**
 * Obsidian → Ideas converter (A11.6).
 *
 * Parses Obsidian markdown notes (frontmatter YAML + body), extracting
 * tags (from frontmatter `tags:` field and inline `#tag`), wikilinks
 * (as idea links), and note content. Returns data suitable for direct
 * insertion into the idea store.
 */

import fs from 'fs';
import path from 'path';

export interface ImportedIdea {
  title: string;
  content: string;
  tags: string[];
  wikilinks: string[];
  notePath: string;
}

/**
 * Parse a single Obsidian markdown file into an ImportedIdea.
 */
export function parseObsidianNote(filePath: string): ImportedIdea {
  const raw = fs.readFileSync(filePath, 'utf8');
  const fileName = path.basename(filePath, '.md');

  let content = raw;
  let frontmatterTags: string[] = [];

  // Extract YAML frontmatter
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fmMatch) {
    content = raw.slice(fmMatch[0].length);
    frontmatterTags = extractFrontmatterTags(fmMatch[1]);
  }

  // Extract inline tags (#tag)
  const inlineTags = extractInlineTags(content);

  // Extract wikilinks [[target]]
  const wikilinks = extractWikilinks(content);

  // Merge tags (deduplicated)
  const allTags = [...new Set([...frontmatterTags, ...inlineTags])];

  return {
    title: fileName,
    content: content.trim(),
    tags: allTags,
    wikilinks,
    notePath: filePath,
  };
}

/**
 * Parse tags from YAML frontmatter block.
 * Handles both array format and comma-separated format:
 *   tags: [a, b, c]
 *   tags:
 *     - a
 *     - b
 */
function extractFrontmatterTags(yaml: string): string[] {
  const tags: string[] = [];

  // Match "tags: [a, b, c]" or "tags: a, b, c"
  const inlineMatch = yaml.match(/^tags:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    return inlineMatch[1]
      .split(',')
      .map((t) => t.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }

  // Match "tags: value" (single value on same line)
  const singleMatch = yaml.match(/^tags:\s+(\S.*)$/m);
  if (singleMatch && !singleMatch[1].startsWith('-')) {
    return singleMatch[1]
      .split(',')
      .map((t) => t.trim().replace(/^#/, ''))
      .filter(Boolean);
  }

  // Match YAML list format:
  //   tags:
  //     - a
  //     - b
  const listMatch = yaml.match(/^tags:\s*\n((?:\s+-\s+.*\n?)+)/m);
  if (listMatch) {
    const lines = listMatch[1].split('\n');
    for (const line of lines) {
      const m = line.match(/^\s+-\s+(.+)/);
      if (m) tags.push(m[1].trim().replace(/^["']|["']$/g, ''));
    }
    return tags;
  }

  return tags;
}

/**
 * Extract inline #tags from markdown body.
 */
function extractInlineTags(content: string): string[] {
  const tags = new Set<string>();
  const re = /(?:^|\s)#([a-zA-ZÀ-ÿ][\w/\-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    tags.add(match[1]);
  }
  return [...tags];
}

/**
 * Extract [[wikilink]] targets from markdown body.
 */
function extractWikilinks(content: string): string[] {
  const links = new Set<string>();
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    links.add(match[1].trim());
  }
  return [...links];
}

/**
 * Import all .md files from an Obsidian vault directory into ImportedIdea[].
 * Skips .obsidian, .trash, and hidden directories.
 */
export async function importVaultAsIdeas(
  vaultPath: string,
  options?: { maxFiles?: number }
): Promise<ImportedIdea[]> {
  const maxFiles = options?.maxFiles ?? 500;
  const ideas: ImportedIdea[] = [];
  const resolved = path.resolve(vaultPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Vault path does not exist: ${resolved}`);
  }

  const IGNORE_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.cliobrain']);

  function walk(dir: string): void {
    if (ideas.length >= maxFiles) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ideas.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (IGNORE_DIRS.has(entry.name) && entry.isDirectory()) continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          ideas.push(parseObsidianNote(full));
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  walk(resolved);
  return ideas;
}
