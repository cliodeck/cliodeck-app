import { describe, it, expect } from 'vitest';
import { BibTeXParser } from '../core/bibliography/BibTeXParser';
import { auditParsedBib } from '../core/bibliography/bibAudit';

describe('BibTeXParser', () => {
  const parser = new BibTeXParser();

  describe('parse', () => {
    it('should parse simple BibTeX entry', () => {
      const bibtex = `
@article{smith2023,
  author = {Smith, John},
  title = {Test Article},
  journal = {Test Journal},
  year = {2023}
}
      `;

      const citations = parser.parse(bibtex);

      expect(citations).toHaveLength(1);
      expect(citations[0].id).toBe('smith2023');
      expect(citations[0].author).toBe('Smith, John');
      expect(citations[0].title).toBe('Test Article');
      expect(citations[0].year).toBe('2023');
      expect(citations[0].journal).toBe('Test Journal');
    });

    it('should parse multiple entries', () => {
      // Parser requires both author and title; add authors to fixtures
      const bibtex = `
@article{author2020,
  author = {Alice},
  title = {First Article},
  year = {2020}
}

@book{author2021,
  author = {Bob},
  title = {Test Book},
  year = {2021}
}
      `;

      const citations = parser.parse(bibtex);

      expect(citations).toHaveLength(2);
      expect(citations[0].type).toBe('article');
      expect(citations[1].type).toBe('book');
    });

    it('should handle French accents correctly', () => {
      const bibtex = `
@article{test2023,
  author = {Fran{\\c{c}}ois Dupont},
  title = {{\\'E}tude sur l'{\\oe}uvre de Victor Hugo},
  year = {2023}
}
      `;

      const citations = parser.parse(bibtex);

      expect(citations).toHaveLength(1);
      expect(citations[0].author).toContain('ç');
      expect(citations[0].title).toContain('É');
      expect(citations[0].title).toContain('œ');
    });

    it('should convert LaTeX ligatures', () => {
      const bibtex = `
@article{test2023,
  author = {Someone},
  title = {L'{\\oe}uvre et l'{\\ae}sthetic},
  year = {2023}
}
      `;

      const citations = parser.parse(bibtex);

      expect(citations[0].title).toContain('œ');
      expect(citations[0].title).toContain('æ');
    });

    it('should handle special characters', () => {
      const bibtex = `
@article{test2023,
  author = {Someone},
  title = {Test---with---em-dashes and--en-dashes},
  year = {2023}
}
      `;

      const citations = parser.parse(bibtex);

      expect(citations[0].title).toContain('—'); // em dash
      expect(citations[0].title).toContain('–'); // en dash
    });

    it('should handle nested braces', () => {
      const bibtex = `
@article{test2023,
  author = {Someone},
  title = {{Test {Nested} Braces}},
  year = {2023}
}
      `;

      const citations = parser.parse(bibtex);

      expect(citations).toHaveLength(1);
      expect(citations[0].title).toContain('Test');
    });

    // Mendeley et BibDesk rangent leurs champs par ordre alphabétique : un nom à tiret
    // (mendeley-groups, Date-Added) arrive avant title. Le parseur avançait juste après son `=`
    // sans sauter la valeur, et plus aucun champ n'était lu : l'entrée, sans titre, était rejetée.
    it('lit une entrée Mendeley dont mendeley-groups précède le titre', () => {
      const bibtex = `@article{Smith2010, author={Smith, John}, doi={10.1000/xyz}, journal={Revue}, mendeley-groups={These}, pages={1--10}, title={{A Title}}, year={2010}}`;

      const citations = parser.parse(bibtex);

      expect(parser.lastRejected).toEqual([]);
      expect(citations).toHaveLength(1);
      expect(citations[0].title).toBe('A Title');
      expect(citations[0].year).toBe('2010');
      expect(citations[0].customFields).toMatchObject({ 'mendeley-groups': 'These', pages: '1–10', doi: '10.1000/xyz' });
    });

    it('lit les champs qui suivent un champ à tiret placé après le titre', () => {
      const bibtex = `@misc{A, title={T}, mendeley-tags={x}, url={https://example.org/a}, year={2001}}`;

      const [citation] = parser.parse(bibtex);

      expect(citation.year).toBe('2001');
      expect(citation.customFields).toMatchObject({ 'mendeley-tags': 'x', url: 'https://example.org/a' });
    });

    it('lit une entrée BibDesk dont Date-Added précède Title', () => {
      const bibtex = [
        '@book{Garde2000,',
        '\tAuthor = {Garde, Paul},',
        '\tDate-Added = {2020-01-02 10:00:00 +0100},',
        '\tDate-Modified = {2020-01-03 11:00:00 +0100},',
        '\tTitle = {Le temps des archives},',
        '\tYear = {2000},',
        '\tBdsk-Url-1 = {https://example.org/garde}}',
      ].join('\n');

      const [citation] = parser.parse(bibtex);

      expect(citation?.title).toBe('Le temps des archives');
      expect(citation.year).toBe('2000');
      expect(citation.customFields).toMatchObject({ 'date-added': '2020-01-02 10:00:00 +0100', 'bdsk-url-1': 'https://example.org/garde' });
    });

    // Le tréma s'écrit {\"u} : la valeur entre guillemets s'arrêtait au guillemet de l'accent.
    it('lit une valeur entre guillemets qui contient un tréma {\\"u}, dans l’auteur et le titre', () => {
      const bibtex = `@book{k2, author = "M{\\"u}ller, Hans", title = "Die M{\\"u}nchner Geschichte", year = 1999}`;

      const citations = parser.parse(bibtex);

      expect(parser.lastRejected).toEqual([]);
      expect(citations).toHaveLength(1);
      expect(citations[0].author).toBe('Müller, Hans');
      expect(citations[0].title).toBe('Die Münchner Geschichte');
      expect(citations[0].year).toBe('1999');
    });

    it('développe les abréviations @string, sans égard à la casse, et les concaténations #', () => {
      const bibtex = [
        '@string{AN = {Archives nationales}}',
        '@String{par = "Paris"}',
        '@STRING{anp = an # ", " # PAR}',
        '@book{k3, title={Inventaire}, publisher = AN, address = anp, year=1950}',
        '@book{k4, title={Fonds}, publisher = an # { (site de } # Par # {)}, year=1960}',
        '@book{k5, title={Inconnu}, publisher = XYZ}',
      ].join('\n');

      const citations = parser.parse(bibtex);

      expect(citations.map((c) => c.publisher)).toEqual([
        'Archives nationales',
        'Archives nationales (site de Paris)',
        // Une abréviation jamais définie reste écrite telle quelle.
        'XYZ',
      ]);
      expect(citations[0].customFields?.address).toBe('Archives nationales, Paris');
      expect(citations[0].year).toBe('1950');
    });

    // Le caractère qui suit un antislash ne compte pas (S07-1-32) : `\}` de `{C:\dossier\}` non
    // plus. Sans fermeture à ce compte, on recompte toutes les accolades, comme BibTeX.
    it('referme une valeur qui finit par un antislash, sans perdre l’entrée ni la suivante', () => {
      const bibtex = ['@misc{A, title={C:\\dossier\\}, year={2000}}', '@misc{B, title={Suite}, year={2001}}'].join('\n');

      const citations = parser.parse(bibtex);

      expect(citations.map((c) => [c.id, c.title, c.year])).toEqual([
        ['A', 'C:\\dossier\\', '2000'],
        ['B', 'Suite', '2001'],
      ]);
      expect(auditParsedBib(bibtex, citations).unreadKeys).toEqual([]);
    });

    // Le résumé devenait `note` à la réécriture, et disparaissait quand l'entrée en avait une.
    it('garde abstract et note distincts', () => {
      const bibtex = [
        '@book{A_2000, title={T}, abstract={Long résumé}}',
        '@book{B_2001, title={U}, note={Réimpr.}, abstract={Autre résumé}}',
      ].join('\n');

      const [a, b] = parser.parse(bibtex);

      expect(a.notes).toBeUndefined();
      expect(a.customFields?.abstract).toBe('Long résumé');
      expect(b.notes).toBe('Réimpr.');
      expect(b.customFields?.abstract).toBe('Autre résumé');
    });

    it('should handle empty or invalid input', () => {
      const citations1 = parser.parse('');
      expect(citations1).toHaveLength(0);

      const citations2 = parser.parse('Not valid BibTeX');
      expect(citations2).toHaveLength(0);
    });
  });

  describe('cleanValue', () => {
    it('should convert all common French accents', () => {
      const testCases = [
        ["{\\'{e}}", 'é'],
        ["{\\'e}", 'é'],
        ["\\'e", 'é'],
        ["{\\`{e}}", 'è'],
        ["{\\^{e}}", 'ê'],
        ['{\\"e}', 'ë'],
        ["{\\c{c}}", 'ç'],
      ];

      for (const [input, expected] of testCases) {
        // Parser requires both author and title; add author so entry is accepted
        const bibtex = `@article{test,author={X},title={${input}},year={2023}}`;
        const citations = parser.parse(bibtex);
        expect(citations[0].title).toContain(expected);
      }
    });
  });

  describe('displayString', () => {
    it('should generate correct display string', () => {
      const bibtex = `
@article{author2023,
  author = {John Smith},
  title = {Test},
  year = {2023}
}
      `;

      const citations = parser.parse(bibtex);

      expect(citations[0].displayString).toBe('John Smith (2023)');
    });

    it('should fall back to title if no author', () => {
      const bibtex = `
@article{test2023,
  title = {Anonymous Work},
  year = {2023}
}
      `;

      const citations = parser.parse(bibtex);

      expect(citations).toHaveLength(1);
      expect(citations[0].displayString).toBe('Anonymous Work');
    });

    // Régression #32 : un volume dirigé (editor sans author) était rejeté
    // silencieusement. Les deux champs restent distincts — les confondre
    // réécrivait les directeurs dans `author` à l'export.
    it('keeps editor apart from author, and still displays the names', () => {
      const bibtex = `
@book{dirige2020,
  editor = {Marc Bloch and Lucien Febvre},
  title = {Mélanges},
  year = {2020}
}
      `;

      const citations = parser.parse(bibtex);

      expect(citations).toHaveLength(1);
      expect(citations[0].author).toBe('');
      expect(citations[0].editor).toBe('Marc Bloch and Lucien Febvre');
      expect(citations[0].displayString).toBe('Marc Bloch and Lucien Febvre (2020)');
    });

    it('tracks rejected entries (missing title) in lastRejected', () => {
      const bibtex = `
@misc{sansTitre2021,
  author = {Quelqu'un},
  year = {2021}
}
@article{ok2022,
  author = {Une Autrice},
  title = {Un titre},
  year = {2022}
}
      `;

      const citations = parser.parse(bibtex);

      expect(citations).toHaveLength(1);
      expect(parser.lastRejected).toEqual([
        { key: 'sansTitre2021', reason: 'missing-title' },
      ]);

      // Réinitialisé au parse suivant.
      parser.parse('@article{a, author = {X}, title = {T}, year = {2000}}');
      expect(parser.lastRejected).toHaveLength(0);
    });

    it('carries the zoterokey field into citation.zoteroKey', () => {
      // Regression test: Zotero sync matches local↔remote citations by
      // zoteroKey. If the parser drops it, every remote item looks new
      // and the sync duplicates the whole corpus.
      const bibtex = `
@misc{Lester_1935,
  author = {Lester, Sean},
  title = {Diary - 13 November 1935},
  year = {1935},
  zoterokey = {45SMZJQK}
}

@misc{Lester_1935,
  author = {Lester, Sean},
  title = {Diary - 14 November 1935},
  year = {1935},
  zoterokey = {QRS88ABC}
}
      `;

      const citations = parser.parse(bibtex);

      expect(citations).toHaveLength(2);
      expect(citations[0].zoteroKey).toBe('45SMZJQK');
      expect(citations[1].zoteroKey).toBe('QRS88ABC');
      // The bibtexKey collides (both `Lester_1935`) — only zoteroKey
      // tells them apart.
      expect(citations[0].id).toBe(citations[1].id);
    });
  });
});
