import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BibTeXParser } from '../BibTeXParser';
import { BibTeXExporter } from '../BibTeXExporter';
import { auditParsedBib } from '../bibAudit';
import { createCitation, type Citation } from '../../../types/citation';

/**
 * Aller-retour d'un `.bib` : lu, réécrit, relu, il doit rendre les mêmes références, et deux
 * réécritures le même fichier. La synchronisation Zotero réécrit le `.bib` du projet depuis sa
 * relecture : tout ce qui ne survit pas à un tour est perdu, ou vu « modifié » à chaque passage.
 *
 * Les fixtures sont écrites à la main d'après le format de chaque outil (voir leur en-tête).
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const BIB_DIR = '/projets/these';

const fixture = (name: string) => readFileSync(path.join(FIXTURES, `${name}.bib`), 'utf-8');

/** L'adresse de la fixture BibDesk : tilde, tiret double et tiret bas. */
const BDSK_URL = 'https://www.univ.example/~garde/these--2000_v2.pdf';

function parse(bib: string): Citation[] {
  return new BibTeXParser().parse(bib, BIB_DIR);
}

const exportBib = (citations: Citation[]) => new BibTeXExporter().exportToString(citations);

const byId = (citations: Citation[], id: string) => {
  const found = citations.find((c) => c.id === id);
  if (!found) throw new Error(`${id} absente : ${citations.map((c) => c.id).join(', ')}`);
  return found;
};

describe.each([
  ['zotero', ['dupont_archives_2010', 'martin_temps_1998']],
  ['better-bibtex', ['dupontArchivesEtat2010', 'martinTempsArchives1998']],
  ['mendeley', ['Dupont2010', 'Martin1998']],
  ['bibdesk', ['Garde2000', 'Leduc1990']],
  ['jabref', ['Dupont2010', 'Garde2000']],
])('aller-retour : %s', (name, ids) => {
  it('toutes les entrées sont lues, en entier', () => {
    const bib = fixture(name);
    const citations = parse(bib);

    expect(citations.map((c) => c.id)).toEqual(ids);
    expect(auditParsedBib(bib, citations).unreadKeys).toEqual([]);
    for (const citation of citations) expect(citation.title).not.toBe('');
  });

  it('lu, réécrit, relu : les mêmes références ; deux réécritures, le même fichier', () => {
    const first = parse(fixture(name));
    const written = exportBib(first);
    const second = parse(written);

    expect(second).toEqual(first);
    expect(exportBib(second)).toBe(written);
    expect(auditParsedBib(written, second).unreadKeys).toEqual([]);
  });
});

describe('aller-retour : ce que chaque format met à l’épreuve', () => {
  it('Zotero : résumé et note restent distincts, url et doi verbatim', () => {
    const citation = byId(parse(fixture('zotero')), 'dupont_archives_2010');

    expect(citation.notes).toBe('Réimpr. 2015');
    expect(citation.customFields?.abstract).toBe('Un long résumé, avec 50 % de chiffres.');
    expect(citation.customFields?.url).toBe('https://www.example.org/~dupont/a_b--c?x=1&y=2');
    expect(citation.file).toBe("/Users/jean/Zotero/storage/ABCD1234/Dupont - 2010 - Les archives de l'État.pdf");

    const written = exportBib([citation]);
    expect(written).toContain('abstract = {Un long résumé, avec 50 \\% de chiffres.}');
    expect(written).toContain('note = {Réimpr. 2015}');
  });

  it('Better BibTeX : le chemin iCloud du PDF est relu tel quel', () => {
    const citation = byId(parse(fixture('better-bibtex')), 'dupontArchivesEtat2010');

    expect(citation.file).toBe(
      '/Users/jean/Library/Mobile Documents/com~apple~CloudDocs/Zotero/storage/ABCD1234/Dupont_2010_Les archives--une histoire.pdf'
    );
    expect(citation.customFields?.abstract).toBe('Un long résumé.');
    expect(citation.notes).toBeUndefined();
  });

  it('Mendeley : le titre est lu malgré mendeley-groups placé avant lui, et le champ à tiret survit', () => {
    const citations = parse(fixture('mendeley'));
    const dupont = byId(citations, 'Dupont2010');

    expect(dupont.title).toBe("Les archives de l'État : une histoire");
    expect(dupont.author).toBe('Dupont, Jean and Müller, Hans');
    expect(dupont.year).toBe('2010');
    expect(dupont.customFields?.['mendeley-groups']).toBe('Thèse');
    expect(dupont.customFields?.url).toBe('https://www.example.org/archives');
    // Limite connue : Mendeley Desktop sous macOS écrit le chemin sans sa barre oblique initiale.
    // Relu comme un chemin relatif, il est rattaché au dossier du .bib, donc faux (comme avant).
    expect(dupont.file).toBe('/projets/these/Users/jean/Documents/Mendeley Desktop/Dupont_2010_Les archives.pdf');
    expect(byId(citations, 'Martin1998').publisher).toBe('Gallimard');
    expect(exportBib([dupont])).toContain('mendeley-groups = {Thèse}');
  });

  it('BibDesk : les champs à tiret avant le titre, et l’abréviation développée', () => {
    const citations = parse(fixture('bibdesk'));
    const garde = byId(citations, 'Garde2000');

    expect(garde.title).toBe('Le temps des archives');
    expect(garde.publisher).toBe('Archives nationales');
    expect(garde.customFields?.['date-added']).toBe('2020-01-02 10:00:00 +0100');
    expect(garde.customFields?.['bdsk-url-1']).toBe(BDSK_URL);
    expect(byId(citations, 'Leduc1990').journal).toBe('Archives nationales : bulletin');
    // À la réécriture, la valeur est écrite développée ; la définition @string ne l'est plus.
    const written = exportBib(citations);
    expect(written).toContain('publisher = {Archives nationales}');
    expect(written).not.toContain('{AN}');
  });

  // Une adresse rangée par BibDesk dans bdsk-url-N est verbatim comme `url` : `~`, `--` et `_`
  // sortent de la réécriture tels qu'ils sont dans le fichier d'origine.
  it('BibDesk : la ligne bdsk-url-1 écrite est celle du fichier d’origine', () => {
    const original = fixture('bibdesk');
    const line = `bdsk-url-1 = {${BDSK_URL}}`;
    expect(original).toContain(line);

    expect(exportBib(parse(original))).toContain(line);
  });

  it('JabRef : le PDF relatif au dossier du fichier, le résumé gardé', () => {
    const citation = byId(parse(fixture('jabref')), 'Dupont2010');

    expect(citation.file).toBe('/projets/these/Dupont2010.pdf');
    expect(citation.customFields?.abstract).toBe('Un long résumé.');
    expect(citation.customFields?.groups).toBe('Thèse');
  });
});

describe('aller-retour : valeurs difficiles', () => {
  const titles = ['Code: function() {', 'a~b', 'C:\\Users\\x', 'Ensemble } fermé', 'Une \\textit{commande} écrite telle quelle'];

  it.each(titles)('le titre « %s » est relu à l’identique, et la réécriture est stable', (title) => {
    const original = createCitation({ id: 'K_2020', type: 'misc', author: 'Dupont, Jean', year: '2020', title });
    const written = exportBib([original]);
    const [reread] = parse(written);

    expect(reread?.title).toBe(title);
    expect(exportBib([reread])).toBe(written);
  });

  // Le texte écrit, pas seulement sa relecture : le parseur relit aussi l'ancienne forme
  // `\textbackslash\{\}`, que pandoc imprime « \{} » (mesuré avec pandoc 3.13, `--citeproc -t
  // plain` : « C:\{}users\{}x »). Écrit en un seul passage, `\textbackslash{}` garde son accolade.
  it.each([
    ['C:\\Users\\x', 'title = {C:\\textbackslash{}Users\\textbackslash{}x}'],
    ['a~b', 'title = {a\\textasciitilde{}b}'],
    ['Code: function() {', 'title = {Code: function() \\{}'],
  ])('le titre « %s » s’écrit %s', (title, line) => {
    const written = exportBib([createCitation({ id: 'K_2020', type: 'misc', author: '', year: '2020', title })]);

    expect(written).toContain(line);
  });

  it('une accolade isolée ne fait pas perdre l’entrée, ni la suivante', () => {
    const written = exportBib([
      createCitation({ id: 'Code_2020', type: 'misc', author: '', year: '2020', title: 'Code: function() {' }),
      createCitation({ id: 'Garde_2000', type: 'book', author: 'Garde, Paul', year: '2000', title: 'Le temps des archives' }),
    ]);

    expect(parse(written).map((c) => c.id)).toEqual(['Code_2020', 'Garde_2000']);
  });

  it('une barre oblique inverse ne grossit pas d’une réécriture à l’autre', () => {
    let citations = [createCitation({ id: 'N', type: 'misc', author: '', year: '', title: 'T', notes: 'voir C:\\Users\\x' })];
    for (let i = 0; i < 3; i++) citations = parse(exportBib(citations));

    expect(citations[0].notes).toBe('voir C:\\Users\\x');
  });

  // `\\` (saut de ligne LaTeX) : le second antislash n'échappe pas l'accolade qui suit, ni pour
  // le compte des accolades ni pour le nettoyage.
  it('un saut de ligne LaTeX suivi d’accolades se lit comme le compte des accolades le lit', () => {
    const [citation] = parse('@misc{e, title={Ligne\\\\{}suivante}, note={a \\\\ b}}');

    expect(citation.title).toBe('Ligne\\\\suivante');
    expect(citation.notes).toBe('a \\\\ b');
    expect(parse(exportBib([citation]))).toEqual([citation]);
  });

  it('un résumé reste un résumé, et ne remplace pas la note', () => {
    const bib = [
      '@book{A_2000, title={T}, abstract={Long résumé}}',
      '@book{B_2001, title={U}, note={Réimpr.}, abstract={Autre résumé}}',
    ].join('\n');

    const written = exportBib(parse(bib));

    expect(written).toContain('abstract = {Long résumé}');
    expect(written).toContain('note = {Réimpr.}');
    expect(written).toContain('abstract = {Autre résumé}');
    expect(written).not.toContain('note = {Long résumé}');
  });
});
