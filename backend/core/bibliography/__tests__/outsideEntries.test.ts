import { describe, it, expect, vi } from 'vitest';
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
  const GARDE = '@book{Garde_2000,\n  title = {Le temps des archives},\n}';

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

  // Le parseur prend pour type de l'entrée tout ce qui suit l'arobase d'une adresse placée avant elle.
  it('une adresse dans l’en-tête : le texte réécrit seul, la relecture ne change pas', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = '% Tenu par jean@univ.example\n\n@book{Garde_2000,\n  title = {T},\n}\n';
    const rewritten = rewrite(previous);

    expect(keepOutsideEntries(previous, rewritten)).toBe(rewritten);
    warn.mockRestore();
  });
});
