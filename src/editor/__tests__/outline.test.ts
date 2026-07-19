import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOutline, replaceLeadingHeading } from '../outline';

const CORPUS = fileURLToPath(new URL('../../../test-fixtures/editor/', import.meta.url));
const fixture = (name: string): string =>
  readFileSync(path.join(CORPUS, name), 'utf-8');

describe('parseOutline', () => {
  it('relève les titres ATX avec niveau, texte et ligne', () => {
    const outline = parseOutline('# Chapitre\n\ntexte\n\n## Section\n\n### Sous-section\n');
    expect(outline.map((h) => [h.level, h.text])).toEqual([
      [1, 'Chapitre'],
      [2, 'Section'],
      [3, 'Sous-section'],
    ]);
    expect(outline.map((h) => h.line)).toEqual([1, 5, 7]);
  });

  it('ignore les titres situés dans un bloc de code', () => {
    const source = [
      '# Vrai titre',
      '',
      '```markdown',
      '# Faux titre',
      '## Faux sous-titre',
      '```',
      '',
      '## Vrai sous-titre',
      '',
      '    # titre indenté (bloc de code)',
      '',
    ].join('\n');
    expect(parseOutline(source).map((h) => h.text)).toEqual([
      'Vrai titre',
      'Vrai sous-titre',
    ]);
  });

  it('relève les titres Setext', () => {
    const outline = parseOutline('Titre principal\n===\n\nSous-titre\n---\n');
    expect(outline.map((h) => [h.level, h.text])).toEqual([
      [1, 'Titre principal'],
      [2, 'Sous-titre'],
    ]);
  });

  it('retire les marqueurs de fermeture ATX', () => {
    expect(parseOutline('## Titre fermé ##\n')[0].text).toBe('Titre fermé');
  });

  it('conserve le non-ASCII et la ponctuation', () => {
    const outline = parseOutline('# Danzig, 1932 — élections au Volkstag\n');
    expect(outline[0].text).toBe('Danzig, 1932 — élections au Volkstag');
  });

  it('rend des offsets exploitables pour naviguer', () => {
    const source = '# A\n\n## B\n';
    const outline = parseOutline(source);
    expect(source.slice(outline[1].from, outline[1].to)).toBe('## B');
  });

  it('retourne une liste vide sans titre', () => {
    expect(parseOutline('Juste du texte.\n\nEt un paragraphe.\n')).toEqual([]);
  });

  it('lit le corpus de fidélité (deck de slides)', () => {
    const titles = parseOutline(fixture('slides-deck.md')).map((h) => h.text);
    // Le `---` piégé dans le bloc de code ne crée pas de titre Setext, et le
    // `#` commenté à l'intérieur du bloc n'est pas relevé.
    expect(titles).toContain('Danzig, 1932');
    expect(titles.some((tt) => tt.includes('pas un séparateur'))).toBe(false);
  });
});

describe('replaceLeadingHeading', () => {
  it('remplace le premier titre de niveau 1', () => {
    expect(replaceLeadingHeading('# Ancien\n\ntexte\n', 'Nouveau')).toBe(
      '# Nouveau\n\ntexte\n'
    );
  });

  it('ajoute un titre quand le fichier n’en a pas', () => {
    expect(replaceLeadingHeading('texte seul\n', 'Titre')).toBe(
      '# Titre\n\ntexte seul\n'
    );
  });

  it('ne prend pas un `#` de bloc de code pour le titre du chapitre', () => {
    const source = ['```sh', '# commentaire shell', '```', '', '# Vrai titre', ''].join('\n');
    const out = replaceLeadingHeading(source, 'Renommé');
    expect(out).toContain('# commentaire shell'); // bloc de code intact
    expect(out).toContain('# Renommé');
    expect(out).not.toContain('# Vrai titre');
  });

  it('laisse le reste du document octet pour octet', () => {
    const source = '# A\r\n\r\nligne CRLF\r\n';
    expect(replaceLeadingHeading(source, 'B')).toBe('# B\r\n\r\nligne CRLF\r\n');
  });

  it('ne touche qu’au premier titre de niveau 1', () => {
    const source = '# Un\n\n# Deux\n';
    expect(replaceLeadingHeading(source, 'X')).toBe('# X\n\n# Deux\n');
  });
});
