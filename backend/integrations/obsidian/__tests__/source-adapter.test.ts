import { describe, it, expect } from 'vitest';
import { entryToSource, parsedNoteToSource } from '../source-adapter.js';
import type {
  ParsedVaultNote,
  VaultFileEntry,
} from '../../../types/vault.js';
import { isSourceType } from '../../../types/source.js';

describe('Obsidian → Source adapter (2.1)', () => {
  const entry: VaultFileEntry = {
    relativePath: 'History/Vichy/Petain.md',
    absolutePath: '/vault/History/Vichy/Petain.md',
    fileName: 'Petain.md',
    directory: 'History/Vichy',
    mtime: 1_700_000_000_000,
    size: 1234,
  };

  it('maps VaultFileEntry to ObsidianNoteSource', () => {
    const src = entryToSource(entry, { vaultPath: '/vault' });
    expect(src.type).toBe('obsidian-note');
    expect(isSourceType(src, 'obsidian-note')).toBe(true);
    expect(src.metadata.vaultPath).toBe('/vault');
    expect(src.metadata.notePath).toBe('History/Vichy/Petain.md');
    expect(src.metadata.title).toBe('Petain');
    expect(src.id).toBe('obsidian:History/Vichy/Petain.md');
    expect(src.updatedAt).toBeDefined();
  });

  it('accepts a custom idFn', () => {
    const src = entryToSource(entry, {
      vaultPath: '/vault',
      idFn: (n) => `note::${n.relativePath.replace(/\//g, '__')}`,
    });
    expect(src.id).toBe('note::History__Vichy__Petain.md');
  });

  it('maps ParsedVaultNote preserving tags/wikilinks/frontmatter', () => {
    const parsed: ParsedVaultNote = {
      relativePath: 'Notes/Idea.md',
      title: 'Idea',
      frontmatter: { author: 'FC', tags: ['ml'] },
      tags: ['ml', 'research'],
      wikilinks: [
        { target: 'Petain', position: { start: 0, end: 10 } },
        { target: 'Vichy', displayText: 'vichy regime', position: { start: 12, end: 30 } },
      ],
      headings: [],
      body: '',
      rawContent: '',
    };
    const src = parsedNoteToSource(parsed, { vaultPath: '/v' });
    expect(src.metadata.tags).toEqual(['ml', 'research']);
    expect(src.metadata.wikilinks).toEqual(['Petain', 'Vichy']);
    expect(src.metadata.frontmatter).toEqual({ author: 'FC', tags: ['ml'] });
  });
});
