/**
 * ObsidianMarkdownParser
 *
 * Parses Obsidian-flavored markdown files extracting:
 * - YAML frontmatter
 * - [[wikilinks]] (with optional |display text and #heading)
 * - #tags (inline and from frontmatter)
 * - Heading hierarchy
 */

import yaml from 'js-yaml';
import type { ParsedVaultNote, WikiLink, VaultHeading } from '../../types/vault.js';

// Regex patterns
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;
const WIKILINK_REGEX = /\[\[([^\]]+)\]\]/g;
const INLINE_TAG_REGEX = /(?:^|\s)#([a-zA-Z0-9_\/-]+)/g;
const HEADING_REGEX = /^(#{1,6})\s+(.+)$/gm;

export class ObsidianMarkdownParser {
  /**
   * Parse a markdown file into structured data
   */
  parse(relativePath: string, rawContent: string): ParsedVaultNote {
    const { frontmatter, body } = this.extractFrontmatter(rawContent);
    const title = this.extractTitle(relativePath, frontmatter, body);
    const wikilinks = this.extractWikilinks(body);
    const inlineTags = this.extractInlineTags(body);
    const frontmatterTags = this.extractFrontmatterTags(frontmatter);
    const tags = this.deduplicateTags([...frontmatterTags, ...inlineTags]);
    const headings = this.extractHeadings(body);

    return {
      relativePath,
      title,
      frontmatter,
      tags,
      wikilinks,
      headings,
      body,
      rawContent,
    };
  }

  /**
   * Extract YAML frontmatter from markdown content
   */
  extractFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
    const match = content.match(FRONTMATTER_REGEX);

    if (!match) {
      return { frontmatter: {}, body: content };
    }

    let frontmatter: Record<string, unknown> = {};
    try {
      const parsed = yaml.load(match[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid YAML — treat as no frontmatter
    }

    const body = content.slice(match[0].length).trimStart();
    return { frontmatter, body };
  }

  /**
   * Determine the note title from frontmatter, first heading, or filename
   */
  extractTitle(relativePath: string, frontmatter: Record<string, unknown>, body: string): string {
    // 1. Frontmatter title
    if (frontmatter.title && typeof frontmatter.title === 'string') {
      return frontmatter.title;
    }

    // 2. First H1 heading
    const h1Match = body.match(/^#\s+(.+)$/m);
    if (h1Match) {
      return h1Match[1].trim();
    }

    // 3. Filename without extension
    const fileName = relativePath.split('/').pop() || relativePath;
    return fileName.replace(/\.md$/i, '');
  }

  /**
   * Extract all [[wikilinks]] from the body
   */
  extractWikilinks(body: string): WikiLink[] {
    const links: WikiLink[] = [];
    let match: RegExpExecArray | null;

    // Reset regex state
    WIKILINK_REGEX.lastIndex = 0;

    while ((match = WIKILINK_REGEX.exec(body)) !== null) {
      const raw = match[1];
      const position = { start: match.index, end: match.index + match[0].length };

      // Parse [[target|display text]] and [[target#heading]]
      let target: string;
      let displayText: string | undefined;
      let heading: string | undefined;

      // Check for display text
      const pipeIndex = raw.indexOf('|');
      if (pipeIndex !== -1) {
        target = raw.substring(0, pipeIndex);
        displayText = raw.substring(pipeIndex + 1);
      } else {
        target = raw;
      }

      // Check for heading anchor
      const hashIndex = target.indexOf('#');
      if (hashIndex !== -1) {
        heading = target.substring(hashIndex + 1);
        target = target.substring(0, hashIndex);
      }

      // Normalize: trim whitespace
      target = target.trim();
      if (!target && !heading) continue;

      links.push({
        target: target || '',
        displayText: displayText?.trim(),
        heading: heading?.trim(),
        position,
      });
    }

    return links;
  }

  /**
   * Extract inline #tags from the body
   */
  extractInlineTags(body: string): string[] {
    const tags: string[] = [];
    let match: RegExpExecArray | null;

    INLINE_TAG_REGEX.lastIndex = 0;

    while ((match = INLINE_TAG_REGEX.exec(body)) !== null) {
      const tag = match[1];
      // Skip if it looks like a heading (e.g., ## Heading)
      if (!tag) continue;
      tags.push(tag);
    }

    return tags;
  }

  /**
   * Extract tags from frontmatter (handles both array and string formats)
   */
  extractFrontmatterTags(frontmatter: Record<string, unknown>): string[] {
    const raw = frontmatter.tags;
    if (!raw) return [];

    if (Array.isArray(raw)) {
      return raw
        .filter((t): t is string => typeof t === 'string')
        .map(t => t.replace(/^#/, ''));
    }

    if (typeof raw === 'string') {
      return raw
        .split(/[,\s]+/)
        .map(t => t.replace(/^#/, '').trim())
        .filter(Boolean);
    }

    return [];
  }

  /**
   * Extract heading hierarchy from the body
   */
  extractHeadings(body: string): VaultHeading[] {
    const headings: VaultHeading[] = [];
    let match: RegExpExecArray | null;

    HEADING_REGEX.lastIndex = 0;

    while ((match = HEADING_REGEX.exec(body)) !== null) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        position: match.index,
      });
    }

    return headings;
  }

  /**
   * Deduplicate and normalize tags
   */
  private deduplicateTags(tags: string[]): string[] {
    const seen = new Set<string>();
    return tags.filter(tag => {
      const normalized = tag.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  /**
   * Generate a snippet from the body (first ~150 chars of meaningful text)
   */
  generateSnippet(body: string, maxLength: number = 150): string {
    // Remove headings, links, emphasis for a clean snippet
    const clean = body
      .replace(/^#{1,6}\s+.+$/gm, '')       // headings
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, display) => display || target) // wikilinks
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown links/images
      .replace(/[*_~`]+/g, '')                // emphasis
      .replace(/\n{2,}/g, ' ')               // collapse multiple newlines
      .trim();

    if (clean.length <= maxLength) return clean;
    return clean.substring(0, maxLength).replace(/\s\S*$/, '') + '...';
  }
}

export const obsidianParser = new ObsidianMarkdownParser();
