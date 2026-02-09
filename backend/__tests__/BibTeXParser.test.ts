import { describe, it, expect } from 'vitest';
import { BibTeXParser } from '../core/bibliography/BibTeXParser';

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
      const bibtex = `
@article{author2020,
  title = {First Article},
  year = {2020}
}

@book{author2021,
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
  title = {{Test {Nested} Braces}},
  year = {2023}
}
      `;

      const citations = parser.parse(bibtex);

      expect(citations).toHaveLength(1);
      expect(citations[0].title).toContain('Test');
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
        const bibtex = `@article{test,title={${input}},year={2023}}`;
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

      expect(citations[0].displayString).toBe('Anonymous Work');
    });
  });
});
