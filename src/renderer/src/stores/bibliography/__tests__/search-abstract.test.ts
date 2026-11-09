/**
 * @vitest-environment jsdom
 *
 * La recherche du panneau Bibliographie trouve une référence par un mot de son
 * résumé. Jusqu'à L05-7, le résumé était lu comme `notes`, que le filtre
 * parcourait ; depuis, il vit dans `customFields`, que le filtre ne lisait pas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useBibliographyStore } from '../../bibliographyStore';
import type { Citation } from '../types';

const citations = (): Citation[] => [
  {
    id: 'Dupont_2010',
    type: 'book',
    author: 'Dupont, Jean',
    year: '2010',
    title: 'Les archives de l’État',
    customFields: { abstract: 'Une histoire de la paléographie et des dépôts départementaux.' },
  },
  {
    id: 'Martin_1998',
    type: 'book',
    author: 'Martin, Anne',
    year: '1998',
    title: 'Le temps des archives',
    notes: 'Réimpr. 2015',
    customFields: { ABSTRACT: 'Sur les cartulaires monastiques.' },
  },
  {
    id: 'Garde_2000',
    type: 'article',
    author: 'Garde, Paul',
    year: '2000',
    title: 'Inventaires',
  },
];

const found = (query: string): string[] => {
  useBibliographyStore.getState().searchCitations(query);
  return useBibliographyStore.getState().filteredCitations.map((c) => c.id);
};

beforeEach(() => {
  useBibliographyStore.setState({
    citations: citations(),
    filteredCitations: citations(),
    searchQuery: '',
    selectedTags: [],
    readingNotes: [],
  });
});

describe('recherche du panneau : le résumé', () => {
  it('un mot présent seulement dans le résumé trouve la référence', () => {
    expect(found('paléographie')).toEqual(['Dupont_2010']);
  });

  it('sans tenir compte de la casse du nom de champ ni du mot', () => {
    expect(found('CARTULAIRES')).toEqual(['Martin_1998']);
  });

  it('témoin : la note se cherche toujours', () => {
    expect(found('réimpr')).toEqual(['Martin_1998']);
  });

  it('témoin : un mot absent partout ne trouve rien', () => {
    expect(found('numismatique')).toEqual([]);
  });
});
