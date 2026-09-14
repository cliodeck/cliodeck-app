import { describe, it, expect } from 'vitest';
import type { Citation, ReadingNoteSummary } from '../types';
import { hiddenAutomaticCount, projectTagsOf, readingNoteOf, referenceTags, sourceTagsOf } from '../referenceTags';

const zotero = (over: Partial<Citation> = {}): Citation => ({
  id: 'Kansteiner_2022',
  type: 'article',
  author: 'Kansteiner, Wulf',
  year: '2022',
  title: 'Digital Doping',
  zoteroKey: 'AAA',
  zoteroTags: [
    { tag: 'hermeneutics', automatic: false },
    { tag: 'Artificial Intelligence', automatic: true },
    { tag: 'GPT-3', automatic: true },
  ],
  ...over,
});

const note = (over: Partial<ReadingNoteSummary>): ReadingNoteSummary => ({
  file: '/p/reading-notes/x.md',
  citekey: 'Kansteiner_2022',
  tags: [],
  ...over,
});

describe('tags d’une référence', () => {
  it('masque par défaut les tags automatiques de Zotero, sans les perdre', () => {
    const c = zotero();
    expect(sourceTagsOf(c, false)).toEqual(['hermeneutics']);
    expect(hiddenAutomaticCount(c, false)).toBe(2);
    expect(sourceTagsOf(c, true)).toEqual(['hermeneutics', 'Artificial Intelligence', 'GPT-3']);
    expect(hiddenAutomaticCount(c, true)).toBe(0);
  });

  it('prend les tags du fichier pour une référence sans lien Zotero', () => {
    const c = zotero({ zoteroKey: undefined, zoteroTags: undefined, tags: ['archives'] });
    expect(sourceTagsOf(c, false)).toEqual(['archives']);
  });

  it('retrouve la note par clé Zotero, même si la clé de citation a changé', () => {
    const notes = [note({ citekey: 'Kansteiner_2022a', zoteroKey: 'AAA', tags: ['chapitre-2'] })];
    expect(readingNoteOf(zotero(), notes)?.tags).toEqual(['chapitre-2']);
  });

  it('n’attribue pas la note d’une autre œuvre qui a porté la même clé', () => {
    const notes = [note({ zoteroKey: 'BBB', tags: ['autre'] })];
    expect(projectTagsOf(zotero(), notes)).toEqual([]);
  });

  it('réunit tags Zotero et étiquettes du projet pour la recherche et le filtre', () => {
    const notes = [note({ zoteroKey: 'AAA', tags: ['chapitre-2', 'hermeneutics'] })];
    expect(referenceTags(zotero(), notes, false)).toEqual(['hermeneutics', 'chapitre-2']);
  });
});
