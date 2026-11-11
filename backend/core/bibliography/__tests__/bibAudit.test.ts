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

  it('une entrée non lue qui porte zoterokey vient de Zotero : elle est désignée comme telle', () => {
    // Le titre retiré à la main du .bib : la seule façon pour une entrée venue de Zotero de ne
    // plus se lire, depuis que le parseur lit les accolades échappées (L05-7).
    const bib = new BibTeXExporter()
      .exportToString([
        createCitation({ id: 'Odd_2021', type: 'article', author: 'Odd, A.', year: '2021', title: 'Ensemble fermé', zoteroKey: 'ODD2021' }),
      ])
      .replace(/^\s*title = .*\n/m, '');
    const result = audit(`${bib}\n@misc{entretien_dupont,\n  note = {Entretien},\n}\n`);

    expect(result.unreadKeys).toEqual(['Odd_2021', 'entretien_dupont']);
    expect(result.unreadFromZotero).toEqual(['Odd_2021']);
  });

  it('une entrée entre parenthèses, que le parseur ne sait pas lire', () => {
    expect(audit('@book(Garde_2000,\n  title = {Le temps},\n)\n').unreadKeys).toEqual(['Garde_2000']);
  });

  // Les types que BibTeX accepte (J2) : l'audit lit le début d'une entrée comme le parseur. Avec un
  // motif plus étroit que le sien, une entrée accentuée qui ne se referme pas passait inaperçue.
  it.each([
    ['accentué', '@thèse{'],
    ['à point', '@my.type{'],
  ])('une entrée de type %s qui ne se referme pas est signalée', (_name, start) => {
    const result = audit(`${start}K2,\n  title = {T2},\n\n@book{Garde_2000,\n  title = {Le temps},\n}\n`);

    expect(result.parsed.map((c) => c.id)).toEqual(['Garde_2000']);
    expect(result.unreadKeys).toEqual(['K2']);
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

  it('témoin : une ligne de commentaire % qui contient une accolade, entre deux entrées', () => {
    const result = audit(
      [
        '@book{Garde_2000,',
        '  title = {Le temps des archives},',
        '}',
        '% à revoir {voir carton}',
        '  %% fermer } plus tard',
        '@misc{carton,',
        '  title = {Carton F7},',
        '}',
      ].join('\n')
    );

    expect(result.parsed.map((c) => c.id)).toEqual(['Garde_2000', 'carton']);
    expect(result.unreadKeys).toEqual([]);
  });

  // J2 : une arobase hors des entrées, juste avant l'une d'elles, ne fait rien signaler, ni dans le
  // fichier d'origine ni dans le fichier que ClioDeck en réécrit ; et chaque entrée garde son type.
  it.each(['% voir aussi @Garde_2000 pour le contexte', '%% Tenu par jean.dupont@univ-paris.example', '@comment(à revoir : pagination)'])(
    'témoin : « %s » juste avant chaque entrée, relu puis réécrit',
    (line) => {
      const original = audit(`${line}\n@book{Garde_2000,\n  title = {Le temps},\n}\n${line}\n@misc{carton,\n  title = {Carton},\n}\n`);
      const rewritten = audit(new BibTeXExporter().exportToString(original.parsed));

      for (const result of [original, rewritten]) {
        expect(result.parsed.map((c) => [c.type, c.id])).toEqual([
          ['book', 'Garde_2000'],
          ['misc', 'carton'],
        ]);
        expect(result.unreadKeys).toEqual([]);
      }
    }
  );

  it('une accolade de trop reste signalée quand un commentaire % la suit', () => {
    const result = audit(
      ['@book{Garde_2000,', '  title = {Le temps}},', '  year = {2000},', '}', '% fin {', '@misc{carton,', '  title = {Carton},', '}'].join('\n')
    );

    expect(result.unreadKeys).toEqual(['Garde_2000']);
  });

  it('témoin : ce que ClioDeck écrit se relit sans rien signaler', () => {
    const bib = new BibTeXExporter().exportToString([
      createCitation({ id: 'Garde_2000', type: 'book', author: 'Garde, Paul', year: '2000', title: 'Le temps des {archives}' }),
      createCitation({ id: 'Anonyme', type: 'misc', author: '', year: '', title: 'Sans auteur', zoteroKey: 'ABCD1234' }),
    ]);

    expect(audit(bib)).toMatchObject({ unreadKeys: [], hasStringMacros: false });
  });

  // L'exporteur écrit une accolade isolée `\{` ou `\}`, que le parseur ne compte plus : l'audit
  // compte comme lui, sinon il signalerait à tort les entrées que le parseur lit.
  it('témoin : une accolade isolée ou une barre oblique inverse écrites par ClioDeck ne sont pas signalées', () => {
    const bib = new BibTeXExporter().exportToString([
      createCitation({ id: 'Odd_2021', type: 'article', author: 'Odd, A.', year: '2021', title: 'Ensemble } fermé', zoteroKey: 'ODD2021' }),
      createCitation({ id: 'Code_2020', type: 'misc', author: '', year: '2020', title: 'Code: function() {' }),
      createCitation({ id: 'Win_2020', type: 'misc', author: '', year: '2020', title: 'C:\\Users\\x' }),
    ]);
    const result = audit(bib);

    expect(result.parsed.map((c) => c.id)).toEqual(['Odd_2021', 'Code_2020', 'Win_2020']);
    expect(result.unreadKeys).toEqual([]);
  });
});

describe('auditParsedBib — les @string que le parseur ne lit pas', () => {
  it('témoin : une définition entre accolades se lit et se développe, rien n’est signalé', () => {
    const result = audit('@string{AN = {Archives nationales}}\n@book{Garde_2000,\n  title = {Le temps},\n  publisher = AN,\n}\n');

    expect(result.parsed[0].publisher).toBe('Archives nationales');
    expect(result.unreadKeys).toEqual([]);
  });

  it('une définition entre parenthèses, que le parseur ne lit pas, est signalée', () => {
    const result = audit('@string(AN = "Archives nationales")\n@book{Garde_2000,\n  title = {Le temps},\n  publisher = AN,\n}\n');

    expect(result.unreadKeys).toEqual(['string']);
  });

  it('une définition dont l’accolade ne se ferme pas est signalée', () => {
    const result = audit('@string{AN = {Archives nationales}\n\n@book{Garde_2000,\n  title = {Le temps},\n  publisher = AN,\n}\n');

    expect(result.unreadKeys).toContain('string');
  });
});

/**
 * Limite assumée (voir l'en-tête de `bibAudit.ts`) : l'audit lit les débuts de ligne sans savoir
 * s'ils tombent dans une valeur. Depuis J2, il lit le type comme le parseur, comme BibTeX : la
 * limite s'étend aux identifiants à point ou accentués, que l'ancien motif ne lisait pas. Le
 * fichier est refusé à tort, mais rien n'est perdu ; et ClioDeck, qui écrit chaque valeur sur une
 * ligne, n'écrit jamais ce faux début.
 */
describe('auditParsedBib — une ligne de valeur qui commence comme une entrée', () => {
  it.each([
    ['ASCII, signalé avant J2', '@archives (2024)'],
    ['à point', '@archives.bsky.social (2024)'],
    ['accentué', '@Élysée (2024)'],
    ['suivi d’une accolade', '@x.y {2024}'],
  ])('limite assumée : « %s » au début d’une ligne de valeur compte pour une entrée, et le fichier réécrit n’en porte plus', (_name, start) => {
    const result = audit(`@book{Garde_2000,\n  title = {Le temps},\n  abstract = {Une étude.\n${start} en parle.},\n}\n`);

    expect(result.parsed.map((c) => c.id)).toEqual(['Garde_2000']);
    expect(result.unreadKeys).toContain('Garde_2000');
    expect(audit(new BibTeXExporter().exportToString(result.parsed)).unreadKeys).toEqual([]);
  });
});
