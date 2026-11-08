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

/**
 * BT1-4 : un style du projet que le moteur ne sait pas appliquer se reconnaît
 * avant de rendre le document, qui gardait sinon `[NO_PRINTED_FORM]` à la
 * place de chaque citation. Styles écrits ici : aucun téléchargement.
 */
// Chaque essai bâtit trois moteurs citeproc-js ; sur un style embarqué complet (Chicago, MLA),
// c'est environ une seconde sur un Mac, et plus de cinq sur la CI chargée (#251) : le délai par
// défaut de Vitest ne mesure pas le style, mais la machine.
describe('CitationEngine.styleProblem', { timeout: 30_000 }, () => {
  const info = '<info><title>Essai</title><id>http://cliodeck.invalid/essai</id></info>';
  const style = (body: string, head = info) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">${head}${body}</style>`;

  it('un style embarqué ou complet : rien à redire', () => {
    const engine = new CitationEngine(resourcesRoot);
    engine.registerStyle(
      'complet',
      style('<citation><layout><names variable="author"><name/></names></layout></citation>')
    );
    expect(engine.styleProblem('chicago-note-bibliography', 'fr-FR')).toBeUndefined();
    expect(engine.styleProblem('complet', 'fr-FR')).toBeUndefined();
  });

  it('un style dépendant, qui renvoie à son parent', () => {
    const engine = new CitationEngine(resourcesRoot);
    engine.registerStyle(
      'dependant',
      style(
        '',
        '<info><title>Revue</title><id>x</id><link href="http://cliodeck.invalid/parent" rel="independent-parent"/></info>'
      )
    );
    expect(engine.styleProblem('dependant', 'fr-FR')).toBe('dependent');
  });

  it('un style sans citation, ou que citeproc-js ne lit pas', () => {
    const engine = new CitationEngine(resourcesRoot);
    engine.registerStyle('sans-citation', style('<bibliography><layout><text variable="title"/></layout></bibliography>'));
    engine.registerStyle('pas-du-xml', 'ceci n’est pas un style');
    expect(engine.styleProblem('sans-citation', 'fr-FR')).toBe('unreadable');
    expect(engine.styleProblem('pas-du-xml', 'fr-FR')).toBe('unreadable');
  });

  it('les styles embarqués ne numérotent pas', () => {
    const engine = new CitationEngine(resourcesRoot);
    expect(engine.styleProblem('modern-language-association', 'fr-FR')).toBeUndefined();
    expect(engine.styleProblem('chicago-note-bibliography', 'en-US')).toBeUndefined();
  });

  it('un style qui numérote ses références, comme IEEE', () => {
    // Chaque groupe est rendu à part : chaque citation y serait « [1] ».
    const engine = new CitationEngine(resourcesRoot);
    engine.registerStyle(
      'numerote',
      style(
        '<citation><layout prefix="[" suffix="]"><text variable="citation-number"/></layout></citation>' +
          '<bibliography><layout><text variable="citation-number"/></layout></bibliography>'
      )
    );
    expect(engine.styleProblem('numerote', 'fr-FR')).toBe('numeric');
  });

  it('un style qui numérote par une macro, dans l’ordre alphabétique décroissant', () => {
    // Le numéro ne se lit pas dans `<citation>`, et la référence citée la
    // première peut recevoir le numéro 2 : seul l'essai le voit.
    const engine = new CitationEngine(resourcesRoot);
    engine.registerStyle(
      'numerote-macro',
      style(
        '<macro name="numero"><text variable="citation-number"/></macro>' +
          '<citation><layout prefix="(" suffix=")"><text macro="numero"/></layout></citation>' +
          '<bibliography><sort><key variable="author" sort="descending"/></sort>' +
          '<layout><text variable="citation-number"/></layout></bibliography>'
      )
    );
    expect(engine.styleProblem('numerote-macro', 'fr-FR')).toBe('numeric');
  });
});
