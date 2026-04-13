import { describe, it, expect } from 'vitest';
import {
  isSourceType,
  type Source,
  type ZoteroSource,
  type ObsidianNoteSource,
} from '../../types/source.js';

describe('Source unified types', () => {
  it('narrows on discriminant via isSourceType', () => {
    const s: Source = {
      id: 'z1',
      type: 'zotero',
      path: 'zotero://select/library/items/ABCD',
      metadata: { itemKey: 'ABCD', title: 'Test' },
    };
    if (isSourceType(s, 'zotero')) {
      const z: ZoteroSource = s;
      expect(z.metadata.itemKey).toBe('ABCD');
    } else {
      throw new Error('narrowing failed');
    }
  });

  it('accepts all 5 variants', () => {
    const variants: Source[] = [
      { id: '1', type: 'file', path: '/a.pdf', metadata: {} },
      { id: '2', type: 'folder', path: '/corpus', metadata: {} },
      { id: '3', type: 'zotero', path: 'z://x', metadata: { itemKey: 'K' } },
      { id: '4', type: 'tropy', path: 't://y', metadata: { itemId: 'I' } },
      {
        id: '5',
        type: 'obsidian-note',
        path: '/vault/note.md',
        metadata: { vaultPath: '/vault', notePath: 'note.md' },
      } satisfies ObsidianNoteSource,
    ];
    expect(variants).toHaveLength(5);
  });

  it('isSourceType returns false for non-matching', () => {
    const s: Source = { id: 'f', type: 'file', path: '/x', metadata: {} };
    expect(isSourceType(s, 'zotero')).toBe(false);
  });
});
