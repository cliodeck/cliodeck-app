import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BibTeXExporter, verbatimSafe } from '../BibTeXExporter';
import { BibTeXParser } from '../BibTeXParser';
import { auditParsedBib } from '../bibAudit';
import { createCitation } from '../../../types/citation';
import { citationToCSL } from '../../citation/citationFromZotero';
import { assignCiteKeys } from '../citekey';
import { isPdfPath } from '../pdf-attachment';
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

  // Écrite `{…\}`, une adresse qui finit par une barre oblique inverse se lisait comme une accolade
  // échappée : avec une accolade isolée ailleurs dans l'entrée, celle-ci ne se refermait plus, et la
  // synchronisation suivante refusait le .bib. `toCitation` passe par la même fonction : la
  // comparaison avec Zotero reste stable.
  it('encode une barre oblique inverse finale, qui fermerait mal la valeur', () => {
    expect(verbatimSafe('https://example.org/a\\')).toBe('https://example.org/a%5C');
    expect(verbatimSafe('https://example.org/a\\b')).toBe('https://example.org/a\\b');

    const odd = createCitation({
      id: 'Odd_2021',
      key: 'Odd_2021',
      type: 'online',
      author: '',
      year: '2021',
      title: 'Code: function() {',
      customFields: { url: verbatimSafe('https://example.org/a\\') },
    });
    const next = createCitation({ id: 'Garde_2000', key: 'Garde_2000', type: 'book', author: 'Garde, Paul', year: '2000', title: 'Le temps des archives' });
    const bib = exporter.exportToString([odd, next]);
    const reread = parser.parse(bib);

    expect(bib).toContain('url = {https://example.org/a%5C}');
    expect(reread).toEqual([odd, next]);
    expect(auditParsedBib(bib, reread).unreadKeys).toEqual([]);
  });
});

/**
 * BibDesk range les adresses d'une notice dans `bdsk-url-1`, `bdsk-url-2`…, le fichier lié dans
 * `bdsk-file-1`… (un alias en base64) ; ses anciennes versions, dans `local-url`. Lus depuis que les
 * noms à tiret le sont (S07-1-14), ces champs passaient par le nettoyage LaTeX (`~` en espace, `--`
 * en tiret demi-cadratin) puis par l'échappement (`_` en `\_`) : la première synchronisation
 * réécrivait des adresses fausses.
 */
describe('champs verbatim de BibDesk', () => {
  const exporter = new BibTeXExporter();
  const parser = new BibTeXParser();
  const URL_BDSK = 'http://www.univ.edu/~garde/these--2000_v2.pdf?a=1&b=50%25#p';
  const ALIAS = 'YnBsaXN0MDDSAQIDBFxy+ZWxhdGl2ZVBhdGhZ/YWxpYXNEYXRh==';
  const LOCAL_URL = 'file://localhost/Users/jean/Thèse/a~b--c_d.pdf';
  const bib = [
    '@book{Garde2000,',
    '\tDate-Added = {2020-01-02 10:00:00 +0100},',
    '\tTitle = {Le temps des archives},',
    `\tBdsk-File-1 = {${ALIAS}},`,
    `\tBdsk-Url-1 = {${URL_BDSK}},`,
    `\tLocal-Url = {${LOCAL_URL}},`,
    '\tmendeley-groups = {a_b--c}}',
  ].join('\n');

  it('relit bdsk-url-N, bdsk-file-N et local-url tels quels', () => {
    const [citation] = parser.parse(bib);

    expect(citation.customFields).toMatchObject({ 'bdsk-url-1': URL_BDSK, 'bdsk-file-1': ALIAS, 'local-url': LOCAL_URL });
  });

  it('les réécrit tels quels, et une réécriture de plus ne change rien', () => {
    const written = exporter.exportToString(parser.parse(bib));

    expect(written).toContain(`bdsk-url-1 = {${URL_BDSK}}`);
    expect(written).toContain(`bdsk-file-1 = {${ALIAS}}`);
    expect(written).toContain(`local-url = {${LOCAL_URL}}`);
    expect(exporter.exportToString(parser.parse(written))).toBe(written);
  });

  it('témoin : un autre champ à tiret reste un texte, nettoyé à la lecture et échappé à l’écriture', () => {
    const [citation] = parser.parse(bib);

    expect(citation.customFields?.['mendeley-groups']).toBe('a_b–c');
    expect(exporter.exportToString([citation])).toContain('mendeley-groups = {a\\_b–c}');
  });
});

/**
 * Le chemin du PDF (`file`) se relit tel qu'il a été écrit. Le nettoyage LaTeX changeait `~` en
 * espace (iCloud : `com~apple~CloudDocs`) et `--` en tiret demi-cadratin ; l'échappement de
 * l'exporteur changeait `\` en `\textbackslash{}`, qui grossissait à chaque synchronisation ; la
 * lettre de lecteur d'un chemin Windows était coupée au deux-points (S07-1-16).
 */
describe('champ file', () => {
  const exporter = new BibTeXExporter();
  const parser = new BibTeXParser();
  const BIB_DIR = '/projets/these';
  const ICLOUD = '/Users/fred/Library/Mobile Documents/com~apple~CloudDocs/These/PDFs/Farge--Foucault_1982 a_b.pdf';

  const withFile = (file: string) =>
    createCitation({ id: 'Farge_1982', type: 'book', author: 'Farge, Arlette', year: '1982', title: 'Le désordre des familles', file });

  it('relit à l’identique un chemin avec tilde, tiret double et tiret bas, sans l’échapper', () => {
    const bib = exporter.exportToString([withFile(ICLOUD)]);

    expect(bib).toContain(`file = {${ICLOUD}}`);
    const [reread] = parser.parse(bib, BIB_DIR);
    expect(reread.file).toBe(ICLOUD);
    expect(exporter.exportToString([reread])).toBe(bib);
  });

  it('écrit un chemin Windows avec des barres obliques, qui ne grossit plus d’une synchronisation à l’autre', () => {
    let citations = [withFile('C:\\Users\\fred\\PDFs\\Farge_1982.pdf')];
    for (let i = 0; i < 3; i++) citations = parser.parse(exporter.exportToString(citations), BIB_DIR);

    expect(citations[0].file).toBe('C:/Users/fred/PDFs/Farge_1982.pdf');
  });

  it('garde la lettre de lecteur d’un chemin Windows', () => {
    const [plain] = parser.parse('@book{k, title={T}, file={C:/x/a.pdf}}', BIB_DIR);
    const [described] = parser.parse('@book{k, title={T}, file={Full Text PDF:C:/x/a.pdf:application/pdf}}', BIB_DIR);

    expect(plain.file).toBe('C:/x/a.pdf');
    expect(described.file).toBe('C:/x/a.pdf');
  });

  it('relit sans antislash un ancien .bib écrit par ClioDeck, dont les échappements LaTeX sont retirés', () => {
    const [unix] = parser.parse('@book{k, title={T}, file={/Users/fred/PDFs/Farge\\_1982 \\& co\\%.pdf}}', BIB_DIR);
    const [windows] = parser.parse(
      '@book{k, title={T}, file={C:\\textbackslash\\{\\}Users\\textbackslash\\{\\}fred\\textbackslash{}a\\_b.pdf}}',
      BIB_DIR
    );

    expect(unix.file).toBe('/Users/fred/PDFs/Farge_1982 & co%.pdf');
    expect(windows.file).toBe('C:\\Users\\fred\\a_b.pdf');
  });

  it('témoin : description:chemin:type de Zotero, plusieurs pièces jointes, chemin relatif', () => {
    const [zotero] = parser.parse(
      '@book{k, title={T}, file={Full Text PDF:/x/a_b.pdf:application/pdf;Snapshot:/x/b.html:text/html}}',
      BIB_DIR
    );
    const [relative] = parser.parse('@book{k, title={T}, file={PDFs/a_b.pdf}}', BIB_DIR);

    expect(zotero.file).toBe('/x/a_b.pdf');
    expect(relative.file).toBe('/projets/these/PDFs/a_b.pdf');
  });

  /** Le chemin que le parseur rend pour ce champ `file`. */
  const read = (file: string) => parser.parse(`@book{k, title={T}, file={${file}}}`, BIB_DIR)[0]?.file;

  // Le traducteur BibTeX de Zotero échappe `\`, `:`, `;` et `$` dans chaque partie de
  // description:chemin:type (`encodeFilePathComponent`, BibTeX.js du dépôt zotero/translators) ;
  // JabRef échappe de même `\`, `:` et `;`. Non décodés, la lettre de lecteur était perdue, le
  // chemin rattaché au dossier du .bib, et un `\;` coupait le chemin au milieu du nom.
  it('décode les échappements de Zotero et de JabRef, sans couper sur un deux-points ou un point-virgule échappés', () => {
    expect(read('Full Text PDF:C\\:\\\\Users\\\\me\\\\Zotero\\\\storage\\\\AB\\\\a_b.pdf:application/pdf')).toBe(
      'C:\\Users\\me\\Zotero\\storage\\AB\\a_b.pdf'
    );
    expect(read(':C\\:\\\\Users\\\\Me\\\\paper.pdf:PDF')).toBe('C:\\Users\\Me\\paper.pdf');
    expect(read('Full Text PDF:/Users/jean/Zotero/storage/AB/Ouvriers \\; patrons.pdf:application/pdf')).toBe(
      '/Users/jean/Zotero/storage/AB/Ouvriers ; patrons.pdf'
    );
    expect(read('Full Text PDF:/Users/jean/Zotero/storage/AB/Titre\\: sous-titre.pdf:application/pdf')).toBe(
      '/Users/jean/Zotero/storage/AB/Titre: sous-titre.pdf'
    );
    expect(read('Full Text PDF:/Users/jean/Zotero/storage/AB/Prix en \\$.pdf:application/pdf')).toBe(
      '/Users/jean/Zotero/storage/AB/Prix en $.pdf'
    );
  });

  // Mendeley Desktop échappe le deux-points de la lettre de lecteur par une barre oblique inverse
  // écrite en LaTeX (`C$\backslash$:`), et le tilde en `\~{}` : formes que décode aussi l'import
  // du traducteur BibTeX de Zotero (BibTeX.js, « Mendeley invention? »).
  it('garde la lettre de lecteur et le tilde d’un chemin Windows écrit par Mendeley', () => {
    expect(read(':C$\\backslash$:/Users/me/Documents/Mendeley Desktop/x\\_y.pdf:pdf')).toBe(
      'C:/Users/me/Documents/Mendeley Desktop/x_y.pdf'
    );
    expect(read(':C$\\backslash$:/Users/me/iCloud/com\\~{}apple\\~{}CloudDocs/x.pdf:pdf')).toBe(
      'C:/Users/me/iCloud/com~apple~CloudDocs/x.pdf'
    );
  });

  it('témoin : un point-virgule non échappé d’un chemin sans description reste dans le chemin', () => {
    expect(read('/projets/these/PDFs/Ouvriers ; patrons.pdf')).toBe('/projets/these/PDFs/Ouvriers ; patrons.pdf');
  });

  // Un point-virgule ne sépare deux pièces jointes que s'il précède une autre description:chemin:type.
  // Ailleurs, il fait partie du nom (Mendeley ne l'échappe pas) : couper là rendait un chemin vide.
  it('un point-virgule non échappé dans description:chemin:type reste dans le chemin ; il sépare deux pièces jointes', () => {
    expect(read(':PDFs/Ouvriers ; patrons.pdf:pdf')).toBe('/projets/these/PDFs/Ouvriers ; patrons.pdf');
    expect(read(':PDFs/a.pdf:pdf;:PDFs/b.pdf:pdf')).toBe('/projets/these/PDFs/a.pdf');
  });

  it('un chemin Zotero sous Windows garde sa lettre de lecteur d’une réécriture à l’autre', () => {
    const [first] = parser.parse(
      '@book{k, title={T}, file={Full Text PDF:C\\:\\\\Users\\\\me\\\\a_b.pdf:application/pdf}}',
      BIB_DIR
    );
    const written = exporter.exportToString([first]);
    const [second] = parser.parse(written, BIB_DIR);

    expect(written).toContain('file = {C\\:/Users/me/a_b.pdf}');
    expect(second.file).toBe('C:/Users/me/a_b.pdf');
    expect(exporter.exportToString([second])).toBe(written);
  });

  // L'accolade s'écrit `\{` : `verbatimSafe` l'écrirait `%7B`, et le nom du fichier changerait.
  // Le deux-points et le point-virgule s'écrivent `\:` et `\;`, comme Zotero et JabRef les écrivent :
  // sinon la relecture coupait le chemin à cet endroit.
  it.each([
    ['/Users/jean/Zotero/storage/AB/Dupont - 2010 - Le {X} et la loi.pdf', 'file = {/Users/jean/Zotero/storage/AB/Dupont - 2010 - Le \\{X\\} et la loi.pdf}'],
    ['/Users/jean/Zotero/storage/AB/Ouvriers ; patrons.pdf', 'file = {/Users/jean/Zotero/storage/AB/Ouvriers \\; patrons.pdf}'],
    ['/Users/jean/Zotero/storage/AB/Titre: sous-titre.pdf', 'file = {/Users/jean/Zotero/storage/AB/Titre\\: sous-titre.pdf}'],
    ['C:/Users/me/a_b.pdf', 'file = {C\\:/Users/me/a_b.pdf}'],
  ])('le chemin « %s » s’écrit %s, et se relit à l’identique', (file, line) => {
    let citations = [withFile(file)];
    const written = exporter.exportToString(citations);
    expect(written).toContain(line);
    expect(written).not.toContain('%7B');

    for (let i = 0; i < 3; i++) citations = parser.parse(exporter.exportToString(citations), BIB_DIR);
    expect(citations[0].file).toBe(file);
    expect(exporter.exportToString(citations)).toBe(written);
  });

  // Le .bib voyage : relatif à son dossier, le chemin d'un PDF du projet se relit dans un projet
  // renommé ou sur un autre Mac, et ne dit plus le chemin local de l'auteur (S07-2-1).
  it('relatif au dossier du .bib quand le PDF y est, et relu à l’identique', () => {
    const bib = exporter.exportToString([withFile('/projets/these/PDFs/Farge 1982.pdf')], { fileBaseDir: BIB_DIR });

    expect(bib).toContain('file = {PDFs/Farge 1982.pdf}');
    const [reread] = parser.parse(bib, BIB_DIR);
    expect(reread.file).toBe('/projets/these/PDFs/Farge 1982.pdf');
    expect(exporter.exportToString([reread], { fileBaseDir: BIB_DIR })).toBe(bib);
  });

  it('absolu quand le PDF est ailleurs, un dossier voisin au nom prolongé compris', () => {
    const bib = exporter.exportToString(
      [withFile('/projets/these-2/PDFs/a.pdf'), withFile('/Users/fred/Zotero/storage/AB/b.pdf')],
      { fileBaseDir: BIB_DIR }
    );

    expect(bib).toContain('file = {/projets/these-2/PDFs/a.pdf}');
    expect(bib).toContain('file = {/Users/fred/Zotero/storage/AB/b.pdf}');
  });

  it('sous Windows aussi, relatif en barres obliques normales', () => {
    const bib = exporter.exportToString([withFile('C:\\Users\\fred\\These\\PDFs\\a_b.pdf')], { fileBaseDir: 'C:\\Users\\fred\\These' });

    expect(bib).toContain('file = {PDFs/a_b.pdf}');
  });

  it('exportToFile écrit relatif au dossier du fichier exporté, et garde absolu ce qui n’y est pas', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-export-bib-'));
    try {
      const inProject = path.join(dir, 'These', 'PDFs', 'a.pdf');
      fs.mkdirSync(path.join(dir, 'These'));
      fs.mkdirSync(path.join(dir, 'Export'));

      await exporter.exportToFile([withFile(inProject)], path.join(dir, 'These', 'bibliography.bib'));
      await exporter.exportToFile([withFile(inProject)], path.join(dir, 'Export', 'envoi.bib'));

      expect(fs.readFileSync(path.join(dir, 'These', 'bibliography.bib'), 'utf8')).toContain('file = {PDFs/a.pdf}');
      expect(fs.readFileSync(path.join(dir, 'Export', 'envoi.bib'), 'utf8')).toContain(`file = {${inProject}}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('un instantané HTML reste un instantané : relire file verbatim ne change pas ce qui est un PDF', () => {
    const [snapshot] = parser.parse('@book{k, title={T}, file={PDFs/13082.html}}', BIB_DIR);
    const [legacy] = parser.parse('@book{k, title={T}, file={PDFs/a\\_b.PDF}}', BIB_DIR);

    expect(isPdfPath(snapshot.file)).toBe(false);
    expect(isPdfPath(legacy.file)).toBe(true);
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
