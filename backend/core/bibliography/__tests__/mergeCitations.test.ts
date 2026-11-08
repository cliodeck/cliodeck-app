/**
 * La règle des doublons de l'import, extraite du panneau (S07-1-3) pour que le main écrive la même
 * fusion que celle que le panneau montrait : le même item Zotero quand il est connu, sinon la même
 * clé BibTeX.
 */
import { describe, expect, it } from 'vitest';
import { mergeCitationLists } from '../mergeCitations';

const ref = (id: string, zoteroKey?: string) => ({ id, ...(zoteroKey ? { zoteroKey } : {}) });

describe('mergeCitationLists', () => {
  it('trois ouvrages en `Unknown_2022`, trois items Zotero : aucun n’est un doublon', () => {
    const existing = [ref('Unknown_2022', 'AAAA1111')];
    const incoming = [ref('Unknown_2022', 'BBBB2222'), ref('Unknown_2022', 'CCCC3333')];

    expect(mergeCitationLists(existing, incoming)).toEqual({
      merged: [...existing, ...incoming],
      newCount: 2,
      duplicates: 0,
    });
  });

  it('le même item Zotero sous une autre clé : un doublon', () => {
    const result = mergeCitationLists([ref('Garde_2000', 'GARD2000')], [ref('garde2000', 'GARD2000')]);

    expect(result).toMatchObject({ newCount: 0, duplicates: 1 });
    expect(result.merged.map((c) => c.id)).toEqual(['Garde_2000']);
  });

  it('sans item Zotero, la même clé : un doublon, y compris dans le fichier importé lui-même', () => {
    const result = mergeCitationLists([ref('Main_2010')], [ref('Main_2010'), ref('Autre_2015'), ref('Autre_2015')]);

    expect(result).toMatchObject({ newCount: 1, duplicates: 2 });
    expect(result.merged.map((c) => c.id)).toEqual(['Main_2010', 'Autre_2015']);
  });
});
