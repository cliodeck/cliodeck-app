import { describe, it, expect } from 'vitest';
import { createCitation, type Citation } from '../../../types/citation';
import type { ZoteroItem } from '../ZoteroAPI';
import { ZoteroDiffEngine } from '../ZoteroDiffEngine';
import { ZoteroSyncResolver } from '../ZoteroSyncResolver';

/**
 * L'appariement local ↔ Zotero doit passer par le `zoteroKey`.
 *
 * Mesuré sur une bibliographie réelle de 69 entrées : quatre clés BibTeX
 * étaient portées par neuf items Zotero distincts (`Unknown_2022` par trois
 * œuvres sans rapport). Tant que le resolver appariait sur `id`, une
 * modification écrasait l'homonyme arrivé en premier et une suppression
 * effaçait la mauvaise référence — une œuvre perdue, une autre dupliquée.
 */

function citation(over: Partial<Citation> & { id: string }): Citation {
  return createCitation({
    type: 'article',
    author: 'Dupont, Jean',
    year: '2022',
    title: 'Titre',
    ...over,
  });
}

function item(
  key: string,
  data: Partial<ZoteroItem['data']> & { title: string }
): ZoteroItem {
  return {
    key,
    version: 0,
    library: { type: 'user', id: 1, name: '' },
    data: {
      key,
      version: 0,
      itemType: 'journalArticle',
      creators: [{ creatorType: 'author', lastName: 'Dupont', firstName: 'Jean' }],
      date: '2022',
      ...data,
    },
  } as ZoteroItem;
}

describe('ZoteroSyncResolver — appariement par zoteroKey', () => {
  const resolver = new ZoteroSyncResolver();

  const homonymes = (): Citation[] => [
    citation({ id: 'Unknown_2022', zoteroKey: 'AAA', title: 'Premier ouvrage' }),
    citation({ id: 'Unknown_2022', zoteroKey: 'BBB', title: 'Deuxième ouvrage' }),
  ];

  it('modifie l’entrée désignée, pas son homonyme', async () => {
    const local = homonymes();
    const diff = {
      added: [],
      modified: [
        {
          local: local[1],
          remote: citation({ id: 'Unknown_2022', zoteroKey: 'BBB', title: 'Deuxième ouvrage (corrigé)' }),
          modifiedFields: ['title'],
        },
      ],
      deleted: [],
      unchanged: [local[0]],
    };

    const result = await resolver.resolveConflicts(diff, local, 'remote');

    expect(result.modifiedCount).toBe(1);
    expect(result.finalCitations.map((c) => c.title)).toEqual([
      'Premier ouvrage',
      'Deuxième ouvrage (corrigé)',
    ]);
  });

  it('supprime l’entrée désignée, pas son homonyme', async () => {
    const local = homonymes();
    const diff = {
      added: [],
      modified: [],
      deleted: [local[1]],
      unchanged: [local[0]],
    };

    const result = await resolver.resolveConflicts(diff, local, 'remote');

    expect(result.deletedCount).toBe(1);
    expect(result.finalCitations).toHaveLength(1);
    expect(result.finalCitations[0].zoteroKey).toBe('AAA');
  });

  it('ne renomme pas une citation déjà écrite dans le manuscrit', async () => {
    // L'auteur a écrit `[@Dupont_2022]` ; Zotero corrige l'année. La clé
    // locale doit survivre, sinon la citation devient orpheline.
    const local = [citation({ id: 'Dupont_2022', zoteroKey: 'AAA' })];
    const diff = {
      added: [],
      modified: [
        {
          local: local[0],
          remote: citation({ id: 'Dupont_2023', zoteroKey: 'AAA', year: '2023' }),
          modifiedFields: ['year'],
        },
      ],
      deleted: [],
      unchanged: [],
    };

    const result = await resolver.resolveConflicts(diff, local, 'remote');

    expect(result.finalCitations[0].id).toBe('Dupont_2022');
    expect(result.finalCitations[0].year).toBe('2023');
  });

  it('ne touche à rien quand le zoteroKey visé a disparu de la liste', async () => {
    const local = [citation({ id: 'Unknown_2022', zoteroKey: 'AAA', title: 'Premier ouvrage' })];
    const diff = {
      added: [],
      modified: [],
      deleted: [citation({ id: 'Unknown_2022', zoteroKey: 'ZZZ', title: 'Autre' })],
      unchanged: [],
    };

    const result = await resolver.resolveConflicts(diff, local, 'remote');

    expect(result.deletedCount).toBe(0);
    expect(result.finalCitations).toHaveLength(1);
  });
});

describe('ZoteroDiffEngine — clés des entrées ajoutées', () => {
  const engine = new ZoteroDiffEngine();

  it('ne réutilise pas une clé déjà prise localement', async () => {
    const local = [citation({ id: 'Dupont_2022', zoteroKey: 'AAA', title: 'Déjà cité' })];
    const remote = [
      item('AAA', { title: 'Déjà cité' }),
      item('BBB', { title: 'Nouvel article du même auteur' }),
    ];

    const diff = await engine.detectChanges(local, remote);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].zoteroKey).toBe('BBB');
    expect(diff.added[0].id).not.toBe('Dupont_2022');
  });

  it('désambiguïse plusieurs ajouts homonymes entre eux', async () => {
    const remote = [
      item('AAA', { title: 'Premier', dateAdded: '2024-01-01' }),
      item('BBB', { title: 'Deuxième', dateAdded: '2024-02-01' }),
      item('CCC', { title: 'Troisième', dateAdded: '2024-03-01' }),
    ];

    const diff = await engine.detectChanges([], remote);

    const ids = diff.added.map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_:-]+$/);
  });
});

describe('ZoteroSyncResolver — fusion « le distant gagne »', () => {
  const resolver = new ZoteroSyncResolver();

  it('ne perd pas ce que Zotero n’expose pas', async () => {
    // Depuis que la synchronisation réécrit le .bib, un champ effacé ici
    // l'est sur le disque : notes, mots-clés et champs BibTeX
    // personnalisés doivent survivre à une correction de titre.
    const local = citation({
      id: 'Dupont_2022',
      zoteroKey: 'AAA',
      title: 'Titre fautif',
      notes: 'À relire pour le chapitre 3',
      keywords: 'archives; IA',
      tags: ['mémoire'],
      booktitle: 'Actes du colloque',
      customFields: { doi: '10.1000/xyz', pages: '12-34' },
      file: '/PDFs/dupont.pdf',
    });
    const remote = citation({
      id: 'Dupont_2022',
      zoteroKey: 'AAA',
      title: 'Titre corrigé',
      tags: [],
    });

    const result = await resolver.resolveConflicts(
      { added: [], modified: [{ local, remote, modifiedFields: ['title'] }], deleted: [], unchanged: [] },
      [local],
      'remote'
    );

    const merged = result.finalCitations[0];
    expect(merged.title).toBe('Titre corrigé');
    expect(merged.notes).toBe('À relire pour le chapitre 3');
    expect(merged.keywords).toBe('archives; IA');
    expect(merged.tags).toEqual(['mémoire']);
    expect(merged.booktitle).toBe('Actes du colloque');
    expect(merged.customFields).toEqual({ doi: '10.1000/xyz', pages: '12-34' });
    expect(merged.file).toBe('/PDFs/dupont.pdf');
  });

  it('accepte les valeurs renseignées côté Zotero', async () => {
    const local = citation({ id: 'Dupont_2022', zoteroKey: 'AAA', journal: '', tags: ['vieux'] });
    const remote = citation({ id: 'Dupont_2022', zoteroKey: 'AAA', journal: 'History & Theory', tags: ['neuf'] });

    const result = await resolver.resolveConflicts(
      { added: [], modified: [{ local, remote, modifiedFields: ['journal'] }], deleted: [], unchanged: [] },
      [local],
      'remote'
    );

    expect(result.finalCitations[0].journal).toBe('History & Theory');
    expect(result.finalCitations[0].tags).toEqual(['neuf']);
  });
});
