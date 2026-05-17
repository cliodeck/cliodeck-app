/**
 * ObsidianExporter
 *
 * Exports chat messages and conversations as .md files into the Obsidian vault.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { VaultExportOptions } from '../../types/vault.js';

const DEFAULT_SUBFOLDER = 'cliobrain-exports';

export class ObsidianExporter {
  private vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  /**
   * Export a single chat message (question + response) as a vault note
   */
  exportMessage(options: VaultExportOptions): string {
    const subfolder = options.subfolder || DEFAULT_SUBFOLDER;
    const exportDir = path.join(this.vaultPath, subfolder);

    // Ensure export directory exists
    fs.mkdirSync(exportDir, { recursive: true });

    // Generate frontmatter
    const frontmatter: Record<string, unknown> = {
      title: this.generateTitle(options.userMessage || ''),
      date: new Date().toISOString().split('T')[0],
      tags: ['cliobrain/export', ...(options.tags || [])],
      source: 'cliobrain',
    };

    if (options.sessionId) {
      frontmatter.session_id = options.sessionId;
    }

    if (options.sources && options.sources.length > 0) {
      frontmatter.cited_documents = options.sources.map(s => {
        const parts = [s.documentTitle];
        if (s.author) parts.unshift(s.author);
        if (s.year) parts.push(`(${s.year})`);
        return parts.join(' - ');
      });
    }

    // Generate markdown body
    const body = this.generateBody(options);

    // Compose full content
    const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 });
    const content = `---\n${yamlStr}---\n\n${body}`;

    // Generate filename and handle conflicts
    const fileName = this.generateFileName(options.userMessage || 'export');
    const filePath = this.resolveConflict(exportDir, fileName);

    fs.writeFileSync(filePath, content, 'utf-8');

    // Return the relative path from vault root
    return path.relative(this.vaultPath, filePath);
  }

  /**
   * Export a full conversation as a vault note
   */
  exportConversation(
    messages: Array<{ role: string; content: string; sources?: VaultExportOptions['sources'] }>,
    options: { sessionId?: string; title?: string; subfolder?: string; tags?: string[] } = {}
  ): string {
    const subfolder = options.subfolder || DEFAULT_SUBFOLDER;
    const exportDir = path.join(this.vaultPath, subfolder);
    fs.mkdirSync(exportDir, { recursive: true });

    // Frontmatter
    const frontmatter: Record<string, unknown> = {
      title: options.title || `Conversation ${new Date().toISOString().split('T')[0]}`,
      date: new Date().toISOString().split('T')[0],
      tags: ['cliobrain/conversation', ...(options.tags || [])],
      source: 'cliobrain',
      message_count: messages.length,
    };

    if (options.sessionId) {
      frontmatter.session_id = options.sessionId;
    }

    // Body
    const bodyParts: string[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        bodyParts.push(`## Question\n\n${msg.content}`);
      } else if (msg.role === 'assistant') {
        bodyParts.push(`## Réponse\n\n${msg.content}`);

        if (msg.sources && msg.sources.length > 0) {
          const sourcesList = msg.sources.map(s => {
            const parts = [s.documentTitle];
            if (s.author) parts.unshift(s.author);
            if (s.year) parts.push(`(${s.year})`);
            if (s.pageNumber) parts.push(`p. ${s.pageNumber}`);
            return `- ${parts.join(' - ')}`;
          });
          bodyParts.push(`### Sources\n\n${sourcesList.join('\n')}`);
        }
      }
    }

    const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 });
    const content = `---\n${yamlStr}---\n\n${bodyParts.join('\n\n---\n\n')}`;

    const fileName = this.generateFileName(options.title || 'conversation');
    const filePath = this.resolveConflict(exportDir, fileName);

    fs.writeFileSync(filePath, content, 'utf-8');
    return path.relative(this.vaultPath, filePath);
  }

  /**
   * Generate a title from the user message (first 60 chars)
   */
  private generateTitle(message: string): string {
    const cleaned = message.replace(/\n/g, ' ').trim();
    if (cleaned.length <= 60) return cleaned;
    return cleaned.substring(0, 57) + '...';
  }

  /**
   * Generate the markdown body for a single message export
   */
  private generateBody(options: VaultExportOptions): string {
    const parts: string[] = [];

    if (options.userMessage) {
      parts.push(`## Question\n\n${options.userMessage}`);
    }

    if (options.assistantMessage) {
      parts.push(`## Réponse\n\n${options.assistantMessage}`);
    }

    if (options.sources && options.sources.length > 0) {
      const sourcesList = options.sources.map(s => {
        const parts = [s.documentTitle];
        if (s.author) parts.unshift(s.author);
        if (s.year) parts.push(`(${s.year})`);
        if (s.pageNumber) parts.push(`p. ${s.pageNumber}`);
        return `- ${parts.join(' - ')}`;
      });
      parts.push(`### Sources\n\n${sourcesList.join('\n')}`);
    }

    return parts.join('\n\n');
  }

  /**
   * Generate a safe filename from text
   */
  private generateFileName(text: string): string {
    const date = new Date().toISOString().split('T')[0];
    const slug = text
      .toLowerCase()
      .replace(/[àáâãäå]/g, 'a')
      .replace(/[èéêë]/g, 'e')
      .replace(/[ìíîï]/g, 'i')
      .replace(/[òóôõö]/g, 'o')
      .replace(/[ùúûü]/g, 'u')
      .replace(/[ç]/g, 'c')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50)
      .replace(/-+$/, '');

    return `${date}-${slug || 'export'}.md`;
  }

  /**
   * Resolve filename conflicts by appending -1, -2, etc.
   */
  private resolveConflict(dir: string, fileName: string): string {
    let filePath = path.join(dir, fileName);

    if (!fs.existsSync(filePath)) return filePath;

    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    let counter = 1;

    while (fs.existsSync(filePath)) {
      filePath = path.join(dir, `${base}-${counter}${ext}`);
      counter++;
    }

    return filePath;
  }
}
