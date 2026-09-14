import { describe, it, expect } from 'vitest';
import { BibTeXExporter } from '../BibTeXExporter';
import { BibTeXParser } from '../BibTeXParser';
import { createCitation } from '../../../types/citation';
import { citationToCSL } from '../../citation/citationFromZotero';
import { assignCiteKeys } from '../citekey';
import type { ZoteroItem } from '../../../integrations/zotero/ZoteroAPI';

/**
 * Pandoc lit un `.bib` en BibLaTeX, où `url`, `doi` et les dates sont des
 * champs verbatim. Mesuré avec pandoc 3.9 : un `\_` écrit par l'échappement
 * LaTeX reste `\_` dans l'URL rendue. Et à la relecture, le nettoyage LaTeX
 * du parseur changeait `~` en espace et `--` en tiret demi-cadratin.
 */

const URL_PIEGE = 'https://www.uni.example/~dupont/a_b--c?x=1&y=2%20z#frag';

describe('champs verbatim', () => {
  const exporter = new BibTeXExporter();
  const parser = new BibTeXParser();

  const citation = () =>
    createCitation({
      id: 'Dupont_2024',
      type: 'online',
      author: 'Dupont, Jean',
      year: '2024',
      title: 'Titre avec & et 50 %',
      customFields: {
        url: URL_PIEGE,
        doi: '10.1000/abc_def--2',
        date: '2024-03-12',
        urldate: '2025-01-02',
      },
    });

  it('écrit URL, DOI et dates sans échappement LaTeX', () => {
    const bib = exporter.exportToString([citation()]);

    expect(bib).toContain(`url = {${URL_PIEGE}}`);
    expect(bib).toContain('doi = {10.1000/abc_def--2}');
    expect(bib).toContain('date = {2024-03-12}');
    // Les champs ordinaires restent échappés.
    expect(bib).toContain('title = {Titre avec \\& et 50 \\%}');
  });

  it('relit URL et DOI à l’identique, et garde la date complète', () => {
    const [reread] = parser.parse(exporter.exportToString([citation()]));

    expect(reread.customFields?.url).toBe(URL_PIEGE);
    expect(reread.customFields?.doi).toBe('10.1000/abc_def--2');
    expect(reread.customFields?.date).toBe('2024-03-12');
    expect(reread.year).toBe('2024');
    // Un second export ne doit rien changer.
    expect(exporter.exportToString([reread])).toBe(exporter.exportToString([citation()]));
  });

  it('neutralise une accolade dans une URL sans changer l’adresse', () => {
    const bib = exporter.exportToString([
      createCitation({
        id: 'K',
        type: 'online',
        author: '',
        year: '2024',
        title: 'T',
        customFields: { url: 'https://example.org/{id}' },
      }),
    ]);
    expect(bib).toContain('url = {https://example.org/%7Bid%7D}');
    expect(parser.parse(bib)).toHaveLength(1);
  });
});

describe('types BibLaTeX vers CSL', () => {
  const csl = (type: string, customFields?: Record<string, string>) =>
    citationToCSL(createCitation({ id: 'K', type, author: 'Dupont, Jean', year: '2025', title: 'T', customFields }));

  it('reconnaît presse et magazine', () => {
    expect(csl('article', { entrysubtype: 'newspaper' }).type).toBe('article-newspaper');
    expect(csl('article', { entrysubtype: 'magazine' }).type).toBe('article-magazine');
    expect(csl('article').type).toBe('article-journal');
  });

  it('reconnaît les types que l’export Zotero produit désormais', () => {
    expect(csl('online').type).toBe('webpage');
    expect(csl('software').type).toBe('software');
    expect(csl('video').type).toBe('motion_picture');
    expect(csl('thesis').type).toBe('thesis');
    expect(csl('report').type).toBe('report');
    expect(csl('inreference').type).toBe('entry-encyclopedia');
  });

  it('préfère la date complète à l’année et porte la date de consultation', () => {
    const item = csl('article', { entrysubtype: 'newspaper', date: '2025-06-16', urldate: '2025-06-20' });
    expect(item.issued).toEqual({ 'date-parts': [[2025, 6, 16]] });
    expect(item.accessed).toEqual({ 'date-parts': [[2025, 6, 20]] });
  });

  it('lit `number` comme fascicule pour un périodique, comme numéro ailleurs', () => {
    expect(csl('article', { number: '4' }).issue).toBe('4');
    const report = csl('report', { number: 'GSP-12' });
    expect(report.issue).toBeUndefined();
    expect(report.number).toBe('GSP-12');
  });

  it('porte la nature d’une thèse en genre', () => {
    expect(csl('thesis', { type: 'Thèse de doctorat' }).genre).toBe('Thèse de doctorat');
  });
});

describe('clés héritées de l’ancien générateur', () => {
  it('ne reconduit pas le tiret bas final d’un item sans date', () => {
    const item = {
      key: 'BULT0001',
      version: 0,
      library: { type: 'user', id: 1, name: '' },
      data: {
        key: 'BULT0001',
        version: 0,
        itemType: 'report',
        title: 'DAMMA Workshop Whitepaper',
        creators: [{ creatorType: 'author', lastName: 'Bultmann', firstName: 'Daniel' }],
      },
    } as ZoteroItem;

    const keys = assignCiteKeys([item], new Set(), { BULT0001: 'Bultmann_' });

    expect(keys.get('BULT0001')).toBe('Bultmann_nd');
  });
});

describe('notice sans date', () => {
  const exporter = new BibTeXExporter();
  const parser = new BibTeXParser();

  it('n’invente pas d’année et reste stable à l’aller-retour', () => {
    // Relu `n.d.`, réécrit `year = {n.d.}`, puis vu « modifié » à chaque
    // synchronisation face à Zotero qui n'a pas de date.
    const original = createCitation({ id: 'Bultmann_nd', type: 'report', author: 'Bultmann, Daniel', year: '', title: 'DAMMA' });
    const bib = exporter.exportToString([original]);

    expect(bib).not.toContain('year');
    const [reread] = parser.parse(bib);
    expect(reread.year).toBe('');
    expect(reread.displayString).toBe('Bultmann, Daniel');
    expect(exporter.exportToString([reread])).toBe(bib);
  });
});

describe('typographie française', () => {
  it('garde les espaces insécables à l’aller-retour', () => {
    // Mesuré sur une bibliographie réelle : « Lire : un braconnage »
    // perdait son espace insécable dès que la synchronisation réécrivait le
    // fichier depuis sa relecture.
    const exporter = new BibTeXExporter();
    const original = createCitation({
      id: 'Certeau_1990',
      type: 'incollection',
      author: 'Certeau, Michel de',
      year: '1990',
      title: 'Chapitre XII. Lire : un braconnage ?',
    });

    const [reread] = new BibTeXParser().parse(exporter.exportToString([original]));

    expect(reread.title).toBe('Chapitre XII. Lire : un braconnage ?');
  });

  it('continue de réduire les espaces et retours à la ligne ordinaires', () => {
    const [c] = new BibTeXParser().parse('@book{k,\n  title = {Un   titre\n    sur deux lignes},\n  year = {2020}\n}');
    expect(c.title).toBe('Un titre sur deux lignes');
  });
});
