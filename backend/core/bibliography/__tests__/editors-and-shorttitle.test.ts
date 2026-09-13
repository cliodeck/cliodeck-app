import { describe, it, expect } from 'vitest';
import { BibTeXExporter } from '../BibTeXExporter';
import { BibTeXParser } from '../BibTeXParser';
import { createCitation } from '../../../types/citation';
import { citationToCSL } from '../../citation/citationFromZotero';
import type { ZoteroItem } from '../../../integrations/zotero/ZoteroAPI';
import { formatCreators } from '../../../integrations/zotero/creators';
import { ZoteroLocalBibTeX } from '../../../integrations/zotero/ZoteroLocalBibTeX';

/**
 * Deux notions que la chaîne confondait :
 *
 * - l'auteur et le directeur d'ouvrage — un livre dirigé n'ayant que des
 *   créateurs `editor`, il sortait avec `author = {Unknown}`, ce qui le
 *   faisait afficher « Unknown (2022) » et lui donnait une clé homonyme
 *   de tous ses semblables ;
 * - le titre court et le titre coupé — l'export fabriquait un
 *   `shorttitle` en tronquant le titre à 47 caractères, que les styles
 *   Chicago affichent tel quel dans les notes abrégées.
 */

function bookSection(): ZoteroItem {
  return {
    key: 'LB4ZZMT9',
    version: 0,
    library: { type: 'user', id: 1, name: '' },
    data: {
      key: 'LB4ZZMT9',
      version: 0,
      itemType: 'book',
      title: 'Digital History and Hermeneutics: Between Theory and Practice',
      shortTitle: 'Digital History and Hermeneutics',
      creators: [
        { creatorType: 'editor', lastName: 'Fickers', firstName: 'Andreas' },
        { creatorType: 'editor', lastName: 'Tatarinov', firstName: 'Juliane' },
      ],
      date: '2022',
    },
  } as ZoteroItem;
}

describe('formatCreators', () => {
  it('sépare les auteurs des directeurs', () => {
    const item = bookSection();
    expect(formatCreators(item, 'author')).toBe('');
    expect(formatCreators(item, 'editor')).toBe('Fickers, Andreas and Tatarinov, Juliane');
  });

  it('ne fabrique jamais le faux nom « Unknown »', () => {
    const item = bookSection();
    item.data.creators = [];
    expect(formatCreators(item, 'author')).toBe('');
  });

  it('accepte les noms en un seul champ', () => {
    const item = bookSection();
    item.data.creators = [{ creatorType: 'author', name: 'Atelier Ecopol' }];
    expect(formatCreators(item, 'author')).toBe('Atelier Ecopol');
  });
});

describe('aller-retour BibTeX', () => {
  const exporter = new BibTeXExporter();
  const parser = new BibTeXParser();

  it('écrit un champ editor et pas de champ author vide', () => {
    const bib = exporter.exportToString([
      createCitation({
        id: 'Fickers_2022',
        type: 'book',
        author: '',
        editor: 'Fickers, Andreas and Tatarinov, Juliane',
        year: '2022',
        title: 'Digital History and Hermeneutics',
      }),
    ]);

    expect(bib).toContain('editor = {Fickers, Andreas and Tatarinov, Juliane}');
    expect(bib).not.toContain('author = {}');
    expect(bib).not.toContain('Unknown');
  });

  it('relit editor sans le recopier dans author', () => {
    const original = createCitation({
      id: 'Fickers_2022',
      type: 'book',
      author: '',
      editor: 'Fickers, Andreas',
      year: '2022',
      title: 'Digital History and Hermeneutics',
      shortTitle: 'Digital History',
    });

    const [reread] = parser.parse(exporter.exportToString([original]));

    expect(reread.author).toBe('');
    expect(reread.editor).toBe('Fickers, Andreas');
    expect(reread.shortTitle).toBe('Digital History');
    // Sans quoi un second export dupliquerait les noms dans les deux champs.
    expect(exporter.exportToString([reread])).toBe(exporter.exportToString([original]));
  });
});

describe('conversion CSL', () => {
  it('porte les directeurs en `editor`, que le style sait rendre', () => {
    const csl = citationToCSL(
      createCitation({
        id: 'Fickers_2022',
        type: 'book',
        author: '',
        editor: 'Fickers, Andreas and Tatarinov, Juliane',
        year: '2022',
        title: 'Digital History and Hermeneutics',
      })
    );

    expect(csl.author).toBeUndefined();
    expect(csl.editor).toEqual([
      { family: 'Fickers', given: 'Andreas' },
      { family: 'Tatarinov', given: 'Juliane' },
    ]);
  });

  it('porte le titre court en `title-short`', () => {
    const csl = citationToCSL(
      createCitation({
        id: 'Hutchinson_2024',
        type: 'article',
        author: 'Hutchinson, Daniel',
        year: '2024',
        title: 'Mapping the Latent Past: Assessing Large Language Models',
        shortTitle: 'Mapping the Latent Past',
      })
    );

    expect(csl['title-short']).toBe('Mapping the Latent Past');
  });
});

describe('displayString', () => {
  it('désigne un ouvrage dirigé par son directeur', () => {
    const citation = createCitation({
      id: 'Fickers_2022',
      type: 'book',
      author: '',
      editor: 'Fickers, Andreas',
      year: '2022',
      title: 'Digital History and Hermeneutics',
    });
    expect(citation.displayString).toBe('Fickers, Andreas (2022)');
  });

  it('retombe sur le titre pour une œuvre anonyme', () => {
    const citation = createCitation({
      id: 'Anon_2022',
      type: 'misc',
      author: '',
      year: '2022',
      title: "What Do AIs 'Know' About History?",
    });
    expect(citation.displayString).toBe("What Do AIs 'Know' About History?");
  });
});

/**
 * Le vrai chemin d'export. `ZoteroLocalBibTeX` importe better-sqlite3,
 * mais le binding natif ne se charge qu'à l'ouverture d'une base :
 * `generateBibTeX` n'en ouvre aucune et tourne sur les deux ABI.
 */
describe('export d’une collection Zotero', () => {
  const bibtex = new ZoteroLocalBibTeX('/inexistant');

  it('écrit les directeurs d’un ouvrage dirigé, jamais « Unknown »', () => {
    const bib = bibtex.generateBibTeX([bookSection()]);

    expect(bib).toContain('@book{Fickers_2022,');
    expect(bib).toContain('editor = {Fickers, Andreas and Tatarinov, Juliane}');
    expect(bib).not.toContain('Unknown');
    expect(bib).not.toContain('author = {}');
  });

  it('reprend le titre court de Zotero sans le fabriquer', () => {
    const bib = bibtex.generateBibTeX([bookSection()]);

    expect(bib).toContain('shorttitle = {Digital History and Hermeneutics}');
    // L'ancien repli coupait le titre à 47 caractères, en plein mot.
    expect(bib).not.toContain('...');
  });

  it('n’invente pas de titre court quand Zotero n’en a pas', () => {
    const item = bookSection();
    item.data.shortTitle = undefined;

    expect(bibtex.generateBibTeX([item])).not.toContain('shorttitle');
  });

  it('reprend le titre de l’ouvrage pour un chapitre', () => {
    const item = bookSection();
    item.data.itemType = 'bookSection';
    item.data.bookTitle = 'Digital History and Hermeneutics';
    item.data.creators = [{ creatorType: 'author', lastName: 'Hiltmann', firstName: 'Torsten' }];

    const bib = bibtex.generateBibTeX([item]);

    expect(bib).toContain('@incollection{Hiltmann_2022,');
    expect(bib).toContain('booktitle = {Digital History and Hermeneutics}');
  });
});
