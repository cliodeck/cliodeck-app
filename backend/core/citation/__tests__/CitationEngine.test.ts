import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { CitationEngine, type CSLItem } from '../CitationEngine.js';
import { citationToCSL, parseBibTeXAuthors } from '../citationFromZotero.js';
import { createCitation } from '../../../types/citation.js';

const resourcesRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  '..',
  '..',
  'resources',
  'csl'
);

const book: CSLItem = {
  id: 'bloch1949',
  type: 'book',
  title: 'Apologie pour l’histoire ou Métier d’historien',
  author: [{ family: 'Bloch', given: 'Marc' }],
  issued: { 'date-parts': [[1949]] },
  publisher: 'Armand Colin',
  'publisher-place': 'Paris',
};

const article: CSLItem = {
  id: 'rosanvallon2003',
  type: 'article-journal',
  title: 'Pour une histoire conceptuelle du politique',
  author: [{ family: 'Rosanvallon', given: 'Pierre' }],
  issued: { 'date-parts': [[2003]] },
  'container-title': 'Revue de synthèse',
  volume: '124',
  page: '11-29',
};

describe('CitationEngine', () => {
  it('formats Chicago notes-bibliography for a book and a journal article', () => {
    const engine = new CitationEngine(resourcesRoot);
    const res = engine.formatCitation([book, article], 'chicago-note-bibliography', 'en-US');

    expect(res.footnotes).toHaveLength(2);
    expect(res.bibliography).toHaveLength(2);

    // Footnote for the book should mention the author surname, title and year.
    expect(res.footnotes[0]).toMatch(/Bloch/);
    expect(res.footnotes[0]).toMatch(/Apologie/);
    expect(res.footnotes[0]).toMatch(/1949/);

    // Bibliography entry for the article should include the journal title.
    const articleBib = res.bibliography.find((b) => /Rosanvallon/.test(b));
    expect(articleBib).toBeDefined();
    expect(articleBib!).toMatch(/Revue de [Ss]ynthèse/);
    expect(articleBib!).toMatch(/2003/);
    expect(articleBib!).toMatch(/11.?29/); // page range (en-dash or hyphen)
  });

  it('converts a BibTeX-style Citation into a CSL-JSON item', () => {
    const c = createCitation({
      id: 'bloch1949',
      type: 'book',
      author: 'Bloch, Marc',
      year: '1949',
      title: 'Apologie pour l’histoire',
      publisher: 'Armand Colin',
      customFields: { address: 'Paris' },
    });
    const csl = citationToCSL(c);
    expect(csl.type).toBe('book');
    expect(csl.author?.[0]).toEqual({ family: 'Bloch', given: 'Marc' });
    expect(csl.issued).toEqual({ 'date-parts': [[1949]] });
    expect(csl['publisher-place']).toBe('Paris');
  });

  it('parses BibTeX author lists with "and" separators', () => {
    const authors = parseBibTeXAuthors('Bloch, Marc and Febvre, Lucien');
    expect(authors).toEqual([
      { family: 'Bloch', given: 'Marc' },
      { family: 'Febvre', given: 'Lucien' },
    ]);
  });
});
