import { describe, it, expect } from 'vitest';
import {
  MAX_MATCHES_PER_CHAPTER,
  findMatches,
  foldForSearch,
  searchManuscript,
  type SearchableDocument,
} from '../manuscript-search';

describe('foldForSearch', () => {
  it('replie la casse et les diacritiques', () => {
    expect(foldForSearch('Église')).toBe('eglise');
    expect(foldForSearch('DANZIG')).toBe('danzig');
  });

  it('préserve la longueur — les décalages doivent rester valides', () => {
    for (const sample of ['Église', 'Frédéric Clavert', 'Dantzig 1919', 'Straße']) {
      expect(foldForSearch(sample)).toHaveLength(sample.length);
    }
  });
});

describe('findMatches', () => {
  const text = "L'église de Dantzig.\nUne autre Église, plus loin.\n";

  it('trouve sans accent ce qui est écrit avec', () => {
    const { matches } = findMatches(text, 'eglise');
    expect(matches).toHaveLength(2);
    // Le décalage pointe bien sur le texte d'origine, accents compris.
    expect(text.slice(matches[0].from, matches[0].to)).toBe('église');
    expect(text.slice(matches[1].from, matches[1].to)).toBe('Église');
  });

  it('rend la ligne 1-indexée de chaque occurrence', () => {
    const { matches } = findMatches(text, 'eglise');
    expect(matches.map((m) => m.line)).toEqual([1, 2]);
  });

  it('rend un extrait de contexte autour de l’occurrence', () => {
    const { matches } = findMatches(text, 'Dantzig');
    expect(matches[0].match).toBe('Dantzig');
    expect(matches[0].before).toContain('église de');
  });

  it('ne confond pas deux graphies distinctes', () => {
    expect(findMatches('Danzig et Dantzig', 'Danzig').matches).toHaveLength(1);
  });

  it('ignore une requête vide ou blanche', () => {
    expect(findMatches(text, '   ').matches).toHaveLength(0);
  });

  it('borne le comptage sur un terme trop commun', () => {
    const flood = 'a '.repeat(MAX_MATCHES_PER_CHAPTER + 50);
    const { matches, truncated } = findMatches(flood, 'a');
    expect(matches).toHaveLength(MAX_MATCHES_PER_CHAPTER);
    expect(truncated).toBe(true);
  });

  it('ne se recouvre pas sur les occurrences chevauchantes', () => {
    // « aa » dans « aaaa » : 2 occurrences disjointes, pas 3.
    expect(findMatches('aaaa', 'aa').matches).toHaveLength(2);
  });
});

describe('searchManuscript', () => {
  const docs: SearchableDocument[] = [
    { chapterId: 'c1', title: 'Ouverture', filePath: 'chapters/01.md', content: 'Dantzig en 1919.', live: false },
    { chapterId: 'c2', title: 'Le Volkstag', filePath: 'chapters/02.md', content: 'Rien ici.', live: false },
    { chapterId: 'c3', title: 'Conclusion', filePath: 'chapters/03.md', content: 'Retour à Dantzig, puis Dantzig encore.', live: true },
  ];

  it('groupe par chapitre et ne retourne que ceux qui matchent', () => {
    const outcome = searchManuscript(docs, 'dantzig');
    expect(outcome.chapters.map((c) => c.chapterId)).toEqual(['c1', 'c3']);
    expect(outcome.total).toBe(3);
  });

  it('conserve l’ordre du manifeste', () => {
    const outcome = searchManuscript(docs, 'dantzig');
    expect(outcome.chapters[0].title).toBe('Ouverture');
    expect(outcome.chapters[1].title).toBe('Conclusion');
  });

  it('signale le chapitre lu dans l’éditeur vivant', () => {
    const outcome = searchManuscript(docs, 'dantzig');
    expect(outcome.chapters.find((c) => c.chapterId === 'c3')?.live).toBe(true);
  });

  it('rend un résultat vide sans échouer', () => {
    expect(searchManuscript(docs, 'introuvable').total).toBe(0);
    expect(searchManuscript([], 'dantzig').chapters).toEqual([]);
  });
});
