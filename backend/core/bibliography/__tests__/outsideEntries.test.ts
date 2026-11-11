import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { keepOutsideEntries } from '../outsideEntries';
import { BibTeXParser } from '../BibTeXParser';
import { BibTeXExporter } from '../BibTeXExporter';
import { auditParsedBib } from '../bibAudit';

/**
 * Ce qu'un `.bib` porte hors de ses entrées, repris à la réécriture (H2) : la synchronisation
 * Zotero et « Fusionner » réécrivent le fichier depuis ses citations, et l'exporteur n'écrit que
 * des entrées. Les fixtures `blocs-*` sont écrites à la main d'après la forme des fichiers de
 * BibDesk et de JabRef, et l'exemple de préambule de BibTeX (voir leur en-tête).
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, `${name}.bib`), 'utf-8');

const parse = (bib: string) => new BibTeXParser().parse(bib);
/** Ce qu'écrivent la synchronisation et la fusion : les seules entrées, depuis les citations. */
const rewrite = (bib: string) => new BibTeXExporter().exportToString(parse(bib));
const count = (text: string, part: string) => text.split(part).length - 1;

/** Le texte de `bib` à partir de `start`, jusqu'à la fin de `end` (ou du fichier). */
const from = (bib: string, start: string, end?: string) => {
  const i = bib.indexOf(start);
  if (i === -1) throw new Error(`« ${start} » absent`);
  return end === undefined ? bib.slice(i).trimEnd() : bib.slice(i, bib.indexOf(end, i) + end.length);
};

const GARDE = '@book{Garde_2000,\n  title = {Le temps des archives},\n}';
/** Un bloc de groupes BibDesk réduit à sa forme : liste de propriétés entre accolades imbriquées. */
const GROUPS = '@comment{BibDesk Static Groups{\n<plist version="1.0"><array></array></plist>\n}}\n';

// Un test qui échoue avant son `mockRestore` laissait l'espion de `console.warn` aux suivants.
afterEach(() => {
  vi.restoreAllMocks();
});

/** Le fichier composé se relit comme les entrées réécrites seules, sans entrée non lue. */
function expectSameReading(composed: string, rewritten: string): void {
  const citations = parse(composed);
  expect(citations).toEqual(parse(rewritten));
  expect(auditParsedBib(composed, citations).unreadKeys).toEqual([]);
}

describe('keepOutsideEntries — fichiers de BibDesk, de JabRef, tenus à la main', () => {
  it('BibDesk : l’en-tête et l’abréviation restent en tête, les deux blocs de groupes en fin, accolades imbriquées comprises', () => {
    const previous = fixture('blocs-bibdesk');
    const rewritten = rewrite(previous);

    const kept = keepOutsideEntries(previous, rewritten);

    const head = previous.slice(0, previous.indexOf('@book{Garde2000,')).trimEnd();
    const groups = from(previous, '@comment{BibDesk Static Groups{');
    expect(kept).toBe(`${head}\n\n${rewritten.trimEnd()}\n\n${groups}\n`);
    expect(count(kept, '@comment{BibDesk Static Groups{')).toBe(1);
    expect(count(kept, '@comment{BibDesk Smart Groups{')).toBe(1);
    expectSameReading(kept, rewritten);
  });

  it('BibDesk : la ligne d’en-tête qui finit par une espace la garde', () => {
    const previous = fixture('blocs-bibdesk');

    expect(keepOutsideEntries(previous, rewrite(previous))).toContain('%% Created for Jean Dupont at 2024-03-12 10:15:42 +0100 \n');
  });

  it('JabRef : les blocs jabref-meta en fin, l’arbre des groupes sur plusieurs lignes, à l’octet', () => {
    const previous = fixture('blocs-jabref');
    const rewritten = rewrite(previous);

    const kept = keepOutsideEntries(previous, rewritten);

    expect(kept.startsWith('% Encoding: UTF-8\n')).toBe(true);
    expect(kept.endsWith(`${from(previous, '@Comment{jabref-meta: databaseType:biblatex;}')}\n`)).toBe(true);
    expect(count(kept, '@Comment{jabref-meta: grouping:')).toBe(1);
    expectSameReading(kept, rewritten);
  });

  it('à la main : le préambule en tête ; le texte d’entre deux entrées en fin, avant ce qui suivait la dernière', () => {
    const previous = fixture('blocs-preambule');
    const rewritten = rewrite(previous);

    const kept = keepOutsideEntries(previous, rewritten);

    expect(kept.startsWith('@PREAMBLE{"\\newcommand{\\noopsort}[1]{}"}\n')).toBe(true);
    expect(kept).toContain('@Comment{Bibliographie de la thèse, tenue à la main.}\n\n@book{Garde2000,');
    const between = from(previous, '% --- Sources imprimées ---', 'fonds AN F7.');
    const last = from(previous, '@comment(à revoir');
    expect(kept.endsWith(`}\n\n${between}\n\n${last}\n`)).toBe(true);
    expectSameReading(kept, rewritten);
  });

  it.each(['blocs-bibdesk', 'blocs-jabref', 'blocs-preambule'])('%s : une seconde réécriture rend le même fichier', (name) => {
    const previous = fixture(name);
    const rewritten = rewrite(previous);
    const once = keepOutsideEntries(previous, rewritten);

    expect(keepOutsideEntries(once, rewrite(once))).toBe(once);
  });
});

describe('keepOutsideEntries — ce qui se lit comme avant', () => {
  it('témoin : rien hors des entrées que des lignes vides et un BOM, le texte réécrit tel quel', () => {
    const previous = `﻿\n\n${GARDE}\n\n\n${GARDE.replace('Garde_2000', 'Autre')}\n\n`;
    const rewritten = rewrite(previous);

    expect(keepOutsideEntries(previous, rewritten)).toBe(rewritten);
  });

  it('une définition @string reste telle quelle ; la valeur réécrite est développée', () => {
    const previous = '@string{AN = {Archives nationales}}\n\n@book{Garde_2000,\n  title = {T},\n  publisher = AN,\n}\n';
    const rewritten = rewrite(previous);

    const kept = keepOutsideEntries(previous, rewritten);

    expect(kept.startsWith('@string{AN = {Archives nationales}}\n\n')).toBe(true);
    expect(kept).toContain('publisher = {Archives nationales}');
  });

  it('un bloc @comment qui ne se referme pas, après la dernière entrée, reste, et l’entrée aussi', () => {
    const previous = `${GARDE}\n\n@comment{à finir\n`;
    const rewritten = rewrite(previous);

    const kept = keepOutsideEntries(previous, rewritten);

    expect(kept).toBe(`${rewritten.trimEnd()}\n\n@comment{à finir\n`);
    expectSameReading(kept, rewritten);
  });

  it('aucune entrée encore : les blocs restent en tête, la référence ajoutée vient après', () => {
    const previous = '@Comment{jabref-meta: databaseType:biblatex;}\n';
    const rewritten = rewrite(GARDE);

    expect(keepOutsideEntries(previous, rewritten)).toBe(`@Comment{jabref-meta: databaseType:biblatex;}\n\n${rewritten}`);
  });

  // Le fichier composé doit se redécouper à l'identique : une fin de ligne CR seule que le
  // découpage ne reconnaîtrait pas ferait rejeter l'en-tête et les groupes.
  it.each([
    ['CRLF', '\r\n'],
    ['CR seul', '\r'],
  ])('fins de ligne %s : l’en-tête et les groupes restent, la réécriture suivante rend le même fichier', (_name, eol) => {
    const previous = ['%% En-tête', '', '@book{Garde_2000,', '  title = {T},', '}', '', '@comment{groupes}', ''].join(eol);
    const rewritten = rewrite(previous);

    const kept = keepOutsideEntries(previous, rewritten);

    expect(kept).toBe(`%% En-tête\n\n${rewritten.trimEnd()}\n\n@comment{groupes}\n`);
    expect(keepOutsideEntries(kept, rewrite(kept))).toBe(kept);
  });

  // Lu aussi comme CR puis LF, chaque CRLF doublait les découpages qu'essaie le moteur
  // d'expressions régulières : quarante lignes vides suivies de texte ne finissaient pas.
  it('CRLF, quarante lignes vides au milieu de l’en-tête : il est repris tel quel', () => {
    const head = `%% En-tête${'\r\n'.repeat(40)}%% Suite de l’en-tête`;
    const previous = `${head}\r\n\r\n@book{Garde_2000,\r\n  title = {T},\r\n}\r\n`;
    const rewritten = rewrite(previous);

    expect(keepOutsideEntries(previous, rewritten)).toBe(`${head}\n\n${rewritten}`);
  });

  it('toutes les entrées retirées : l’en-tête et les groupes restent', () => {
    const previous = `% En-tête\n\n${GARDE}\n\n@comment{groupes}\n`;

    expect(keepOutsideEntries(previous, rewrite(''))).toBe('% En-tête\n\n@comment{groupes}\n');
  });
});

describe('keepOutsideEntries — ce qui changerait la relecture n’est pas repris', () => {
  // Le parseur lit une entrée écrite dans un @comment : gardé, le commentaire la doublerait à
  // chaque réécriture, puisque la réécriture l'écrit aussi.
  it('une entrée écrite dans un @comment : le texte réécrit seul, rien ne se double', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = '@comment{@article{Cache_1990, title={Dans un commentaire}}}\n\n@book{Garde_2000,\n  title = {T},\n}\n';
    const rewritten = rewrite(previous);
    expect(parse(rewritten).map((c) => c.id)).toEqual(['Cache_1990', 'Garde_2000']);

    expect(keepOutsideEntries(previous, rewritten)).toBe(rewritten);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // Ce qui ne change pas la relecture reste : une entrée cachée dans un commentaire d'en-tête ne
  // fait pas perdre les groupes de la fin, qui n'y sont pour rien.
  it('une entrée dans un @comment d’en-tête, des groupes en fin : les groupes restent, rien ne se double', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = `@comment{@article{Cache_1990, title={Dans un commentaire}}}\n\n@book{Garde_2000,\n  title = {T},\n}\n\n${GROUPS}`;
    const rewritten = rewrite(previous);

    const kept = keepOutsideEntries(previous, rewritten);

    expect(kept).toBe(`${rewritten.trimEnd()}\n\n${GROUPS}`);
    expectSameReading(kept, rewritten);
    expect(keepOutsideEntries(kept, rewrite(kept))).toBe(kept);
    warn.mockRestore();
  });

  it('une entrée dans un @comment entre deux entrées, un en-tête : l’en-tête reste, rien ne se double', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = `% En-tête\n\n${GARDE}\n\n@comment{@article{Cache_1990, title={Dans un commentaire}}}\n\n${GARDE.replace('Garde_2000', 'Autre')}\n`;
    const rewritten = rewrite(previous);

    const kept = keepOutsideEntries(previous, rewritten);

    expect(kept).toBe(`% En-tête\n\n${rewritten}`);
    expectSameReading(kept, rewritten);
    warn.mockRestore();
  });

  // Ce qui séparait deux entrées et ce qui suivait la dernière se jugent à part : une entrée cachée
  // dans un commentaire entre deux entrées ne fait pas perdre les groupes de la fin, qui n'y sont
  // pour rien. L'audit ne la signale pas : la synchronisation et la fusion écrivent ce fichier.
  it.each([
    ['groupes BibDesk', `@comment{@article{Cache_1990, title={Dans un commentaire}}}`, GROUPS],
    ['réglages JabRef', `@comment{@article{Cache_1990,\n  title = {Dans un commentaire},\n}}`, '@Comment{jabref-meta: databaseType:biblatex;}\n'],
  ])('une entrée dans un @comment entre deux entrées, des %s en fin : l’en-tête et la fin restent, une fois', (_name, hidden, tail) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = `% En-tête\n\n${GARDE}\n\n${hidden}\n\n${GARDE.replace('Garde_2000', 'Autre')}\n\n${tail}`;
    const rewritten = rewrite(previous);
    expect(auditParsedBib(previous, parse(previous)).unreadKeys).toEqual([]);

    const kept = keepOutsideEntries(previous, rewritten);

    expect(kept).toBe(`% En-tête\n\n${rewritten.trimEnd()}\n\n${tail}`);
    expectSameReading(kept, rewritten);
    expect(keepOutsideEntries(kept, rewrite(kept))).toBe(kept);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * Une arobase hors des entrées, dans un commentaire `%`, une adresse, un bloc entre parenthèses.
 * Le parseur collait au type de l'entrée qui suit tout ce qui allait de cette arobase à l'accolade
 * de l'entrée, et la réécriture l'écrivait avec elle : repris aussi hors des entrées, ce texte
 * revenait en fin de fichier à chaque réécriture (H2), et pandoc refusait le fichier. Depuis J2, le
 * type est l'identifiant qui suit la dernière arobase avant l'accolade : ce texte est hors des
 * entrées, repris comme le reste, et rien ne s'ajoute d'une réécriture à l'autre.
 */
describe('keepOutsideEntries — une arobase hors des entrées', () => {
  const A = '@book{Garde2000,\n  title = {Le temps des archives},\n  year = {2000},\n}\n';
  const B = '@article{Leduc1990,\n  title = {Le carnet},\n  year = {1990},\n}\n';
  const JABREF = '@Comment{jabref-meta: databaseType:biblatex;}';

  /** Quatre réécritures de suite : le fichier de la première, chaque fois. */
  function expectSettled(previous: string): string {
    const once = keepOutsideEntries(previous, rewrite(previous));
    let current = once;
    for (let i = 0; i < 3; i++) {
      current = keepOutsideEntries(current, rewrite(current));
      expect(current, `réécriture ${i + 2}`).toBe(once);
    }
    expectSameReading(once, rewrite(previous));
    return once;
  }

  // J2 : la ligne qui porte l'arobase est du texte hors des entrées, reprise entière, à l'octet, et
  // l'entrée réécrite commence par son type. `expectSettled` relit et redécoupe le fichier composé :
  // le parseur et le découpage disent la même chose de l'endroit où l'entrée commence.
  const LINES = [
    ['un commentaire % qui cite une clé', '% voir aussi @Garde2000 pour le contexte'],
    ['une adresse', '%% Tenu par jean.dupont@univ-paris.example'],
    ['un bloc entre parenthèses', '@comment(à revoir : pagination de Leduc1990)'],
  ];

  it.each(LINES)('%s juste avant la première entrée : la ligne reste en tête, entière ; l’entrée commence par son type', (_name, line) => {
    const previous = `${line}\n${A}\n${B}\n${JABREF}\n`;
    const rewritten = rewrite(previous);

    const kept = expectSettled(previous);

    expect(rewritten.match(/^@.*$/gm)).toEqual(['@book{Garde2000,', '@article{Leduc1990,']);
    expect(kept).toBe(`${line}\n\n${rewritten.trimEnd()}\n\n${JABREF}\n`);
  });

  it.each(LINES)('%s juste avant une autre entrée : la ligne passe en fin, entière, avant ce qui suivait la dernière', (_name, line) => {
    const previous = `${A}\n${line}\n${B}\n${JABREF}\n`;
    const rewritten = rewrite(previous);

    const kept = expectSettled(previous);

    expect(rewritten.match(/^@.*$/gm)).toEqual(['@book{Garde2000,', '@article{Leduc1990,']);
    expect(kept).toBe(`${rewritten.trimEnd()}\n\n${line}\n\n${JABREF}\n`);
  });

  it('dans un commentaire % entre deux entrées : rien ne revient en fin de fichier', () => {
    const kept = expectSettled(`% Bibliographie\n\n${A}\n% voir aussi @Garde2000 pour le contexte\n${B}\n${JABREF}\n`);

    expect(count(kept, '@Garde2000 pour le contexte')).toBe(1);
    expect(count(kept, '% voir aussi')).toBe(1);
    expect(kept.startsWith('% Bibliographie\n\n@book{Garde2000,')).toBe(true);
    expect(kept.endsWith(`${JABREF}\n`)).toBe(true);
  });

  it('dans un @comment entre deux entrées : le bloc reste, une fois, et rien ne s’ajoute', () => {
    const kept = expectSettled(`${A}\n@comment{Notices reçues de paul@archives.fr}\n\n${B}\n${GROUPS}`);

    expect(count(kept, '@comment{Notices reçues de paul@archives.fr}')).toBe(1);
    expect(kept.endsWith(GROUPS)).toBe(true);
  });

  it('un bloc entre parenthèses entre deux entrées : rien ne s’ajoute', () => {
    const kept = expectSettled(`${A}\n@comment(à revoir)\n\n${B}\n${JABREF}\n`);

    expect(count(kept, '@comment(à revoir)')).toBe(1);
    expect(kept.endsWith(`${JABREF}\n`)).toBe(true);
  });

  // L'adresse ne se colle plus au type de la première entrée (J2) : la ligne d'en-tête reste
  // entière, et les groupes de la fin aussi.
  it('une adresse dans l’en-tête : la ligne reste entière, en tête, et les groupes de la fin restent', () => {
    const previous = `%% Tenu par jean.dupont@univ-paris.example\n\n${A}\n${B}\n${GROUPS}`;
    const rewritten = rewrite(previous);

    const kept = expectSettled(previous);

    expect(kept).toBe(`%% Tenu par jean.dupont@univ-paris.example\n\n${rewritten.trimEnd()}\n\n${GROUPS}`);
  });

  // Le bloc d'en-tête qui porte une adresse ne colle plus sa fin au type de la première entrée
  // (J2) : c'est un bloc comme un autre, repris en tête, sans rien changer à la relecture.
  it('une adresse dans un @comment d’en-tête : le bloc reste en tête, les groupes en fin', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = `@comment{Tenu par jean@univ.example}\n\n${GARDE}\n\n${GROUPS}`;
    const rewritten = rewrite(previous);

    const kept = expectSettled(previous);

    expect(kept).toBe(`@comment{Tenu par jean@univ.example}\n\n${rewritten.trimEnd()}\n\n${GROUPS}`);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // Trouvé par un fuzz de la revue de H2 : l'adresse collait au type de la seconde entrée une
  // accolade fermante, qui refermait, dans le fichier composé, le @comment laissé ouvert en tête ;
  // l'en-tête restait à la première réécriture et partait à la deuxième. Depuis J2, rien ne se colle
  // au type : tout reste, et le fichier ne change plus.
  it('un @comment non refermé en tête, une adresse dans un bloc entre deux entrées : tout reste, et la réécriture suivante rend le même fichier', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = '@comment{à finir\n@book{K1,\n  title = {T1},\n}\n@comment{Notices de paul@archives.fr}\n@book{K2,\n  title = {T2},\n}\n';
    const rewritten = rewrite(previous);

    const kept = expectSettled(previous);

    expect(kept).toBe(`@comment{à finir\n\n${rewritten.trimEnd()}\n\n@comment{Notices de paul@archives.fr}\n`);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // Le fichier composé doit se redécouper à l'identique. Ici, l'en-tête ouvre un @comment(…) qu'il
  // ne referme pas, et un chemin finit par une barre oblique inverse, que la réécriture écrit
  // `\textbackslash{}` : les accolades du fichier composé ne se comptent plus comme celles de
  // l'ancien, et la parenthèse du bloc de fin referme celui de l'en-tête, qui avale l'entrée.
  // Composé sans ce contrôle, l'en-tête restait à la première réécriture, et partait à la deuxième
  // avec le bloc de fin (trouvé par un fuzz, J2). Avec lui, le fichier ne change plus dès la première.
  it('un @comment( non refermé en tête, un chemin qui finit par une barre oblique inverse : la réécriture suivante rend le même fichier', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = '@comment(à finir\n\n@book{K1,\n  title = {C:\\dossier\\},\n}\n\n@comment(à revoir)\n';
    const rewritten = rewrite(previous);

    const kept = expectSettled(previous);

    expect(kept).toBe(`${rewritten.trimEnd()}\n\n@comment(à revoir)\n`);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // « @Garde2000 (chap. 3 » se lit comme un bloc entre parenthèses, que le parseur ne lit pas : il
  // reprend après la parenthèse ouvrante et lit l'entrée qui suit. Le découpage sautait jusqu'à la
  // parenthèse fermante, plus bas : il ne voyait pas l'entrée, et le contrôle écartait l'en-tête et
  // le commentaire de l'historien.
  it.each([
    ['une clé', '% voir aussi @Garde2000 (chap. 3', '% fin du chapitre)'],
    ['une adresse', '% contact jean@univ (bureau 12', '% voir :-)'],
  ])('une parenthèse ouverte après %s, refermée après l’entrée : tout reste, à l’octet', (_name, opening, closing) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = `${opening}\n${A}\n${closing}\n${B}\n${JABREF}\n`;
    const rewritten = rewrite(previous);
    expect(parse(previous).map((c) => [c.type, c.id])).toEqual([
      ['book', 'Garde2000'],
      ['article', 'Leduc1990'],
    ]);

    const kept = expectSettled(previous);

    expect(kept).toBe(`${opening}\n\n${rewritten.trimEnd()}\n\n${closing}\n\n${JABREF}\n`);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // Les types que BibTeX accepte (`@thèse{`, `@my.type{`) : l'entrée est réécrite comme les autres.
  // Avec un motif plus étroit que celui de BibTeX, elle restait dans le fichier comme du texte hors
  // des entrées, et n'était plus une référence.
  it.each(['@thèse{', '@my.type{', '@misc:web{'])('une entrée %s : réécrite comme les autres, rien hors des entrées', (start) => {
    const previous = `${A.replace('@book{', start)}\n${B}`;
    const rewritten = rewrite(previous);

    expect(rewritten.match(/^@.*$/gm)).toEqual([`${start}Garde2000,`, '@article{Leduc1990,']);
    expect(keepOutsideEntries(previous, rewritten)).toBe(rewritten);
  });

  // Limite connue, à décider (revue de J2) : dans une ligne `%`, une arobase suivie d'un identifiant
  // puis d'une accolade ouvrante se lit comme le début d'une entrée. Le parseur la rejette, faute de
  // titre, mais le découpage la compte : la réécriture coupe la ligne à l'arobase, et la copie de
  // sécurité ne la garde entière que jusqu'à la réécriture suivante. Le cas d'une clé
  // (`@Garde2000 {`) l'était déjà avant J2 ; en lisant le type comme BibTeX, J2 l'étend aux
  // adresses et aux URL (le point, le deux-points). Avec une parenthèse, la ligne reste entière
  // (plus haut). Le témoin dit ce qui tient déjà : les entrées se lisent, et le fichier ne change
  // plus d'une réécriture à l'autre. Les `it.fails` disent ce qu'on attend : ils échouent tant que
  // la limite tient, et passeront au vert quand elle sera levée.
  const BRACE_LINES = [
    ['une clé', '% voir aussi @Garde2000 {p. 12}'],
    ['une adresse', '%% Tenu par jean@univ.fr {perso}'],
    ['une URL', '% Profil : https://mastodon.social/@historien/{billets}'],
  ];

  it.each(BRACE_LINES)('témoin : %s suivie d’une accolade, dans une ligne de commentaire : les entrées se lisent, le fichier ne change plus', (_name, line) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = `${line}\n${A}\n${B}`;

    expect(parse(previous).map((c) => [c.type, c.id])).toEqual([
      ['book', 'Garde2000'],
      ['article', 'Leduc1990'],
    ]);
    expect(rewrite(previous).match(/^@.*$/gm)).toEqual(['@book{Garde2000,', '@article{Leduc1990,']);
    expectSettled(previous);
  });

  it.fails.each(BRACE_LINES)('%s suivie d’une accolade, dans une ligne de commentaire : la ligne reste entière', (_name, line) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = `${line}\n${A}\n${B}`;

    expect(keepOutsideEntries(previous, rewrite(previous)).startsWith(`${line}\n`)).toBe(true);
  });
});

/**
 * Le découpage et le parseur disent la même chose de l'endroit où commence chaque entrée : le
 * découpage voit chaque entrée que lit le parseur, et rien d'autre. Sinon le fichier composé se
 * relirait autrement que les entrées réécrites, et `keepOutsideEntries` écarterait une partie, en
 * le disant au journal. Hors de ce corpus : une entrée écrite dans un `@comment`, que le parseur lit
 * et que le découpage laisse au commentaire (étape 4 de J2, hors de cette PR).
 */
describe('keepOutsideEntries — le découpage et le parseur voient les mêmes entrées', () => {
  const A = '@book{Garde2000,\n  title = {Le temps des archives},\n  year = {2000},\n}\n';
  const B = '@article{Leduc1990,\n  title = {Le carnet},\n  year = {1990},\n}\n';
  const FIXTURE_NAMES = ['zotero', 'better-bibtex', 'bibdesk', 'jabref', 'mendeley', 'blocs-bibdesk', 'blocs-jabref', 'blocs-preambule'];

  // Chaque fixture porte deux entrées ; chaque cas écrit à la main, deux aussi.
  it.each([
    ...FIXTURE_NAMES.map((name) => [`la fixture ${name}`, fixture(name)]),
    ['un commentaire % qui cite une clé', `% voir aussi @Garde2000 pour le contexte\n${A}\n% voir aussi @Leduc1990\n${B}`],
    ['une adresse sur la ligne de l’entrée', `% voir aussi @Garde2000 ${A}\n${B}`],
    ['des fins de ligne CRLF', `% voir aussi @Garde2000\r\n${A.replace(/\n/g, '\r\n')}\r\n${B.replace(/\n/g, '\r\n')}`],
    ['des blocs entre parenthèses', `@comment(en-tête)\n${A}\n@comment(à revoir)\n${B}\n@preamble("x")\n`],
    ['une parenthèse ouverte dans un commentaire', `% voir aussi @Garde2000 (chap. 3\n${A}\n% fin)\n${B}`],
    ['des types que BibTeX accepte', `${A.replace('@book{', '@thèse{')}\n% voir @x.y (\n${B.replace('@article{', '@misc:web{')}`],
  ])('%s', (_name, previous) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rewritten = rewrite(previous);
    expect(parse(previous)).toHaveLength(2);

    const kept = keepOutsideEntries(previous, rewritten);

    expect(warn).not.toHaveBeenCalled();
    expectSameReading(kept, rewritten);
    expect(keepOutsideEntries(kept, rewrite(kept))).toBe(kept);
    warn.mockRestore();
  });
});
