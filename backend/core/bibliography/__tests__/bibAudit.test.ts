import { describe, it, expect } from 'vitest';
import { auditParsedBib } from '../bibAudit';
import { BibTeXParser } from '../BibTeXParser';
import { BibTeXExporter } from '../BibTeXExporter';
import { createCitation } from '../../../types/citation';

/**
 * Le contrôle d'un parse : ce que le texte du `.bib` contient, contre ce que le parseur a rendu.
 *
 * `lastRejected` ne voit que les entrées sans titre. Une accolade qui ne se ferme pas fait sauter
 * l'entrée sans rien y noter, et une définition `@string` disparaît à la réécriture : la
 * synchronisation Zotero réécrivait le fichier sans elles, en silence (S07-1-2).
 */

function audit(bib: string) {
  const parser = new BibTeXParser();
  const parsed = parser.parse(bib);
  return { ...auditParsedBib(bib, parsed), parsed, rejected: parser.lastRejected };
}

describe('auditParsedBib — ce qui n’est pas une entrée', () => {
  it('@comment et @string ne comptent pas comme des entrées ; @string est signalé', () => {
    const result = audit(
      [
        '@comment{jabref-meta: databaseType:biblatex;}',
        '@string{AN = "Archives nationales"}',
        '@book{Garde_2000,',
        '  title = {Le temps des archives},',
        '  publisher = AN,',
        '  year = {2000},',
        '}',
        '@preamble{"\\newcommand{\\noop}[1]{}"}',
      ].join('\n')
    );

    expect(result.unreadKeys).toEqual([]);
    expect(result.hasStringMacros).toBe(true);
  });

  it('sans @string, rien n’est signalé', () => {
    const result = audit('@comment{rien}\n@misc{x,\n  title = {Un titre},\n}\n');

    expect(result).toMatchObject({ unreadKeys: [], hasStringMacros: false });
  });

  it('@String en majuscules est une définition comme une autre', () => {
    expect(audit('@String{an = {Archives nationales}}\n').hasStringMacros).toBe(true);
  });
});

describe('auditParsedBib — les entrées que le parseur a laissées', () => {
  it('une entrée sans titre, une autre au titre vide', () => {
    const result = audit(
      [
        '@misc{entretien_dupont,',
        '  author = {Dupont, Jean},',
        '  note = {Entretien du 12 mars 1998},',
        '  year = {1998},',
        '}',
        '@misc{carton_AN_F7_1234,',
        '  title = {},',
        '}',
        '@book{Garde_2000,',
        '  title = {Le temps des archives},',
        '}',
      ].join('\n')
    );

    expect(result.unreadKeys).toEqual(['entretien_dupont', 'carton_AN_F7_1234']);
  });

  it('une accolade qui ne se ferme pas : l’entrée est signalée alors que lastRejected est vide', () => {
    const result = audit(
      [
        '@book{Garde_2000,',
        '  title = {Le {temps des archives},',
        '  year = {2000},',
        '}',
        '',
        '@misc{carton,',
        '  title = {Carton F7},',
        '}',
      ].join('\n')
    );

    expect(result.rejected).toEqual([]);
    expect(result.parsed.map((c) => c.id)).toEqual(['carton']);
    expect(result.unreadKeys).toEqual(['Garde_2000']);
  });

  it('une accolade fermante de trop : l’entrée lue à moitié est signalée', () => {
    const result = audit(
      ['@book{Garde_2000,', '  title = {Le temps}},', '  year = {2000},', '}', '@misc{carton,', '  title = {Carton},', '}'].join(
        '\n'
      )
    );

    // Le parseur rend l'entrée, sans son année : la réécrire la perdrait.
    expect(result.rejected).toEqual([]);
    expect(result.parsed.find((c) => c.id === 'Garde_2000')?.year).toBe('');
    expect(result.unreadKeys).toEqual(['Garde_2000']);
  });

  it('une entrée entre parenthèses, que le parseur ne sait pas lire', () => {
    expect(audit('@book(Garde_2000,\n  title = {Le temps},\n)\n').unreadKeys).toEqual(['Garde_2000']);
  });

  it('deux entrées de même clé : une seule lue, la clé est signalée', () => {
    const result = audit(
      ['@misc{Lester_1935,', '  title = {Diary, January},', '}', '@misc{Lester_1935,', '  note = {Diary, February},', '}'].join('\n')
    );

    expect(result.parsed).toHaveLength(1);
    expect(result.unreadKeys).toEqual(['Lester_1935']);
  });
});

describe('auditParsedBib — pas de refus à tort', () => {
  it('témoin : deux entrées de même clé, toutes deux lues', () => {
    const result = audit(
      ['@misc{Lester_1935,', '  title = {Diary, January},', '}', '@misc{Lester_1935,', '  title = {Diary, February},', '}'].join('\n')
    );

    expect(result.unreadKeys).toEqual([]);
  });

  it('témoin : BOM, fins de ligne Windows et entrées indentées', () => {
    const result = audit('\uFEFF@book{a,\r\n  title = {A},\r\n}\r\n\r\n  @article{b,\r\n  title = {B},\r\n}\r\n');

    expect(result.parsed.map((c) => c.id)).toEqual(['a', 'b']);
    expect(result.unreadKeys).toEqual([]);
  });

  it('témoin : deux entrées sur une même ligne, une adresse électronique dans une valeur', () => {
    const result = audit('@misc{a, title = {A}} @misc{b, title = {B}}\n@misc{c,\n  note = {jean@example.org},\n  title = {C},\n}\n');

    expect(result.parsed.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(result.unreadKeys).toEqual([]);
  });

  it('témoin : ce que ClioDeck écrit se relit sans rien signaler', () => {
    const bib = new BibTeXExporter().exportToString([
      createCitation({ id: 'Garde_2000', type: 'book', author: 'Garde, Paul', year: '2000', title: 'Le temps des {archives}' }),
      createCitation({ id: 'Anonyme', type: 'misc', author: '', year: '', title: 'Sans auteur', zoteroKey: 'ABCD1234' }),
    ]);

    expect(audit(bib)).toMatchObject({ unreadKeys: [], hasStringMacros: false });
  });
});
