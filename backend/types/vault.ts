/**
 * Obsidian vault types for ClioBrain
 */

export interface WikiLink {
  target: string;
  displayText?: string;
  heading?: string;
  position: { start: number; end: number };
}

export interface VaultHeading {
  level: number;
  text: string;
  position: number;
}

export interface ParsedVaultNote {
  relativePath: string;
  title: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  wikilinks: WikiLink[];
  headings: VaultHeading[];
  body: string;
  rawContent: string;
}

export interface VaultFileEntry {
  relativePath: string;
  absolutePath: string;
  fileName: string;
  directory: string;
  mtime: number;
  size: number;
}

export interface VaultNoteSummary {
  id: string;
  relativePath: string;
  title: string;
  tags: string[];
  wikilinksCount: number;
  backlinksCount: number;
  modifiedAt: string;
  indexedAt: string;
  snippet?: string;
}

export interface VaultNoteDetail extends VaultNoteSummary {
  frontmatter: Record<string, unknown>;
  wikilinks: WikiLink[];
  backlinks: Array<{ relativePath: string; title: string }>;
  body: string;
}

export interface VaultTreeNode {
  name: string;
  type: 'folder' | 'file';
  relativePath: string;
  children?: VaultTreeNode[];
  noteId?: string;
  tags?: string[];
}

export interface VaultChunk {
  id: string;
  noteId: string;
  content: string;
  chunkIndex: number;
  sectionHeading?: string;
  embedding?: Float32Array;
}

export interface VaultIndexingProgress {
  stage: 'scanning' | 'parsing' | 'chunking' | 'embedding' | 'resolving-links' | 'complete' | 'error';
  progress: number;
  message: string;
  currentFile?: string;
  filesProcessed: number;
  filesTotal: number;
}

export interface VaultExportOptions {
  sessionId?: string;
  messageId?: string;
  userMessage?: string;
  assistantMessage?: string;
  sources?: Array<{
    documentTitle: string;
    author?: string;
    year?: string;
    pageNumber?: number;
  }>;
  tags?: string[];
  subfolder?: string;
}
