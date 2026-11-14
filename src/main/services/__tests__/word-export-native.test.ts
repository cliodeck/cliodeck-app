import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import PizZip from 'pizzip';
import {
  WordExportService,
  splitAbstract,
  pandocUnresolvedCitations,
} from '../word-export';
import { bibliographyService } from '../bibliography-service';
import { CitationEngine, defaultCSLResourcesRoot } from '../../../../backend/core/citation/CitationEngine';
import type { OutcomeIssue } from '../../../../backend/types/outcome';
import { symlinkAvailable } from '../../../../backend/__tests__/helpers/native-guards';

vi.setConfig({ testTimeout: 60_000 });

/**
 * Régression (export Word d'un article réel, 2026-10-02) : le générateur
 * docx interne laissait du markdown littéral dans les notes, le résumé et
 * les citations en retrait, et les clés de citation restaient des clés.
 *
 * On génère un vrai .docx par le chemin interne (pandoc déclaré absent) et
 * on lit son XML : c'est le document que l'auteur ouvre qui fait foi.
 */
let dir: string;

/** Texte seul d'une partie du docx, balises retirées. */
const plain = (xml: string): string => xml.replace(/<[^>]+>/g, '');

async function exportNative(
  content: string,
  extra: {
    abstract?: string;
    citation?: { useEngine: boolean; style?: string; locale?: string };
    prepare?: (projectPath: string) => void;
    /** Fichiers du projet, relatifs à lui, que la fenêtre transmet. */
    templatePath?: string;
    bibliographyPath?: string;
  } = {}
): Promise<{
  document: string;
  footnotes: string;
  rels: string;
  contentTypes: string;
  unresolved?: string[];
  warnings?: OutcomeIssue[];
}> {
  const projectPath = mkdtempSync(join(dir, 'projet-'));
  if (extra.abstract) writeFileSync(join(projectPath, 'abstract.md'), extra.abstract);
  extra.prepare?.(projectPath);
  const service = new WordExportService();
  vi.spyOn(
    service as unknown as { checkPandoc: () => Promise<boolean> },
    'checkPandoc'
  ).mockResolvedValue(false);
  const outputPath = join(projectPath, 'sortie.docx');
  const result = await service.exportToWord({
    projectPath,
    projectType: 'article',
    content,
    outputPath,
    metadata: { title: 'Titre', author: 'Autrice' },
    citation: extra.citation,
    templatePath: extra.templatePath && join(projectPath, extra.templatePath),
    bibliographyPath: extra.bibliographyPath && join(projectPath, extra.bibliographyPath),
  });
  expect(result.success).toBe(true);
  const zip = new PizZip(readFileSync(outputPath));
  const read = (name: string): string => zip.file(name)?.asText() ?? '';
  return {
    document: read('word/document.xml'),
    footnotes: read('word/footnotes.xml'),
    rels: read('word/_rels/footnotes.xml.rels') + read('word/_rels/document.xml.rels'),
    contentTypes: read('[Content_Types].xml'),
    unresolved: result.unresolvedCitations,
    warnings: result.warnings,
  };
}

/**
 * Un modèle .dotx minimal, tel que Word l'enregistre : la partie principale se déclare
 * `template.main+xml`, et son corps est `body`.
 */
function dotx(body: string): Buffer {
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ' +
      'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml"/>' +
      '</Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>'
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      `<w:p><w:r><w:t>${body}</w:t></w:r></w:p>` +
      '</w:body></w:document>'
  );
  return zip.generate({ type: 'nodebuffer' });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cliodeck-word-native-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('générateur docx interne : markdown en ligne', () => {
  it('interprète le markdown des notes de bas de page', async () => {
    const { footnotes, rels } = await exportNative(
      'Texte[^a].\n\n[^a]: Voir *La Méditerranée* et [le site](https://tropy.org/).\n'
    );
    const text = plain(footnotes);
    expect(text).toContain('Voir La Méditerranée et le site.');
    expect(text).not.toContain('*');
    expect(text).not.toContain('](');
    expect(footnotes).toMatch(/<w:i\/>.*La Méditerranée/s);
    expect(rels).toContain('https://tropy.org/');
  });

  it('ne prend pas le tiret bas d’une clé pour un début d’italique', async () => {
    const { document } = await exportNative(
      'Srnicek [@Srnicek_2025] décrit les tactiques d’un _braconneur_. Fin.\n'
    );
    expect(plain(document)).toContain('Srnicek [@Srnicek_2025] décrit les tactiques d’un braconneur. Fin.');
  });

  it('retire l’antislash d’un caractère échappé', async () => {
    const { document } = await exportNative('Elle écrit : « \\[...] un terme de marketing ».\n');
    expect(plain(document)).toContain('« [...] un terme');
    expect(plain(document)).not.toContain('\\');
  });

  it('garde gras et liens dans une citation en retrait', async () => {
    const { document, rels } = await exportNative(
      '> **Avertissement :** écrit avec [ClioDeck](https://cliodeck.app).\n'
    );
    expect(plain(document)).toContain('Avertissement : écrit avec ClioDeck.');
    expect(document).toMatch(/<w:b\/>.*Avertissement/s);
    expect(rels).toContain('https://cliodeck.app');
  });

  it('retire le titre du résumé quelle que soit la langue, et le reprend', async () => {
    const { document } = await exportNative('Corps.\n', {
      abstract: '# Abstract\n\nUn *résumé* soigné.\n',
    });
    const text = plain(document);
    expect(text).toContain('Abstract');
    expect(text).toContain('Un résumé soigné.');
    expect(text).not.toContain('#');
    expect(text).not.toContain('Résumé');
  });

  describe.skipIf(!symlinkAvailable)('abstract.md en lien symbolique (décision Q16)', () => {
    it('lié hors du projet : il n’entre pas dans le document, qui s’exporte quand même', async () => {
      const outside = join(dir, 'journal-prive.md');
      writeFileSync(outside, '# Journal\n\nSECRET-HORS-PROJET\n');
      const { document } = await exportNative('Corps.\n', {
        prepare: (projectPath) => symlinkSync(outside, join(projectPath, 'abstract.md')),
      });
      expect(plain(document)).toContain('Corps.');
      expect(plain(document)).not.toContain('SECRET-HORS-PROJET');
    });

    it('lié dans le projet : il reste imprimé', async () => {
      const { document } = await exportNative('Corps.\n', {
        prepare: (projectPath) => {
          writeFileSync(join(projectPath, 'brouillon-resume.md'), '# Résumé\n\nUn résumé relié.\n');
          symlinkSync('brouillon-resume.md', join(projectPath, 'abstract.md'));
        },
      });
      expect(plain(document)).toContain('Un résumé relié.');
    });
  });
});

describe('générateur docx interne : citations par le moteur', () => {
  beforeAll(async () => {
    await bibliographyService.parseContent(
      '@book{Farge_2013,\n  author = {Farge, Arlette},\n  title = {The Allure of the Archives},\n  publisher = {Yale University Press},\n  year = {2013}\n}\n' +
        '@article{Url_2019,\n  author = {Durand, Marie},\n  title = {Recherche},\n  journal = {Revue},\n  year = {2019},\n' +
        '  url = {https://gallica.bnf.fr/sru?operation=searchRetrieve&query=x&page=2}\n}\n'
    );
  });

  /**
   * Revue de L10-5 : la citation rendue en place dans une note de l'auteur passe par
   * `cslHtmlToMarkdown`. Un `&` d'adresse échappé en `\&` restait dans le texte et dans la cible
   * du lien : `marked` ne retire pas l'antislash d'une adresse nue.
   */
  it('une adresse citée dans une note de l’auteur garde ses `&`, en texte comme en lien', async () => {
    const { footnotes, rels } = await exportNative('Texte.[^f]\n\n[^f]: Voir [@Url_2019].\n', {
      citation: { useEngine: true, style: 'chicago-note-bibliography', locale: 'fr-FR' },
    });
    expect(plain(footnotes)).toContain('sru?operation=searchRetrieve&amp;query=x&amp;page=2');
    expect(footnotes).not.toContain('\\&amp;');
    expect(rels).toContain('Target="https://gallica.bnf.fr/sru?operation=searchRetrieve&amp;query=x&amp;page=2"');
  });

  it('remplace les clés, y compris dans une note de l’auteur et sous forme nue', async () => {
    const { document, footnotes, unresolved } = await exportNative(
      'Le monde de Farge[^f], repris par @Farge_2013, et encore [@Farge_2013].\n\n' +
        '[^f]: [@Farge_2013]. Paru en 1989.\n',
      { citation: { useEngine: true, style: 'chicago-note-bibliography', locale: 'en-US' } }
    );
    const all = plain(document) + plain(footnotes);
    expect(all).not.toContain('@Farge_2013');
    expect(unresolved).toBeUndefined();
    expect(plain(footnotes)).toContain('The Allure of the Archives');
    expect(footnotes).toMatch(/<w:i\/>.*The Allure of the Archives/s);
    // Pas de note dans la note : aucun appel littéral.
    expect(plain(footnotes)).not.toMatch(/\[\^\d+\]/);
    expect(plain(document)).toContain('repris par Farge,');
  });

  it('signale les clés introuvables au lieu de réussir en silence', async () => {
    const { unresolved } = await exportNative('Mystère [@Fantome_1999].\n', {
      citation: { useEngine: true, style: 'chicago-note-bibliography', locale: 'en-US' },
    });
    expect(unresolved).toEqual(['Fantome_1999']);
  });
});

/**
 * S12-1-2 : la fenêtre d'export transmet d'office le premier .dotx trouvé à la racine du projet.
 * Sur le chemin interne, le document construit (titres, notes, citations) était jeté et remplacé
 * par le modèle : sans balise `{content}`, le .docx ne contenait plus une ligne de l'auteur ; avec
 * elle, le markdown s'y imprimait tel quel, sous le type d'un modèle (`template.main+xml`) que Word
 * ouvre comme un modèle et non comme un document. Dans les deux cas, export « réussi ».
 */
describe('modèle .dotx sur le chemin interne (S12-1-2)', () => {
  const TEXTE = 'CORPSTEXTE avec **gras**[^1].\n\n[^1]: NOTEDELAUTEUR.\n';

  it('un modèle de styles sans balise {content} : le texte de l’auteur reste, et le modèle est dit ignoré', async () => {
    const { document, footnotes, warnings } = await exportNative(TEXTE, {
      prepare: (projectPath) => writeFileSync(join(projectPath, 'styles.dotx'), dotx('Modèle de styles')),
      templatePath: 'styles.dotx',
    });

    expect(plain(document)).toContain('CORPSTEXTE avec gras');
    expect(plain(document)).not.toContain('Modèle de styles');
    expect(plain(footnotes)).toContain('NOTEDELAUTEUR.');
    expect(warnings).toContainEqual({ code: 'export.word.templateIgnored', params: { file: 'styles.dotx' } });
  });

  it('un modèle illisible (balise ouverte) : le texte reste, et le modèle est dit ignoré', async () => {
    const { document, warnings } = await exportNative(TEXTE, {
      prepare: (projectPath) => writeFileSync(join(projectPath, 'casse.dotx'), dotx('Accolade {ouverte')),
      templatePath: 'casse.dotx',
    });

    expect(plain(document)).toContain('CORPSTEXTE');
    expect(warnings).toContainEqual({ code: 'export.word.templateIgnored', params: { file: 'casse.dotx' } });
  });

  it('un modèle à balise {content} : rempli, déclaré document et non modèle, et la réserve dit le markdown brut', async () => {
    const { document, contentTypes, warnings } = await exportNative(TEXTE, {
      prepare: (projectPath) => writeFileSync(join(projectPath, 'revue.dotx'), dotx('En-tête {content} pied')),
      templatePath: 'revue.dotx',
    });

    expect(plain(document)).toContain('CORPSTEXTE');
    expect(contentTypes).toContain('wordprocessingml.document.main+xml');
    expect(contentTypes).not.toContain('template.main+xml');
    expect(warnings).toContainEqual({ code: 'export.word.templateRawMarkdown', params: { file: 'revue.dotx' } });
  });
});

/**
 * S12-2-2 : sans pandoc, le générateur interne ne rend les citations qu'avec un style (celui de la
 * case cochée, ou celui du projet). Sans style, ou sans bibliographie, les `[@clé]` restaient
 * telles quelles dans le .docx, et l'export était annoncé réussi sans un mot.
 */
describe('citations laissées en clés sur le chemin interne (S12-2-2)', () => {
  const FARGE = '@book{farge1989,\n  author = {Farge, Arlette},\n  title = {Le goût de l’archive},\n  year = {1989}\n}\n';

  it('sans bibliographie : les clés restées telles quelles sont nommées, hors code', async () => {
    const { document, unresolved } = await exportNative(
      'Texte cité [@farge1989]. Un `[@encode]` en ligne.\n\n```\n[@enbloc]\n```\n'
    );

    expect(plain(document)).toContain('[@farge1989]');
    expect(unresolved).toEqual(['farge1989']);
  });

  it('avec une bibliographie, sans pandoc ni style : la réserve dit pourquoi, et nomme les clés', async () => {
    const { document, unresolved, warnings } = await exportNative('Texte cité [@farge1989; @autre2001].\n', {
      prepare: (projectPath) => writeFileSync(join(projectPath, 'refs.bib'), FARGE),
      bibliographyPath: 'refs.bib',
    });

    expect(plain(document)).toContain('[@farge1989; @autre2001]');
    expect(warnings).toContainEqual({
      code: 'export.word.citationsNotFormatted',
      params: { keys: 'farge1989, autre2001' },
    });
    expect(unresolved).toBeUndefined();
  });
});

/**
 * S12-1-14, côté Word : l'assemblage omet un chapitre introuvable et le notait en console. Le
 * document sortait sans lui ; le résultat le dit désormais.
 */
describe('livre : chapitre omis à l’assemblage', () => {
  it('le .docx sort sans lui, et la réserve le nomme', async () => {
    const projectPath = mkdtempSync(join(dir, 'livre-'));
    mkdirSync(join(projectPath, 'chapters'));
    writeFileSync(join(projectPath, 'chapters', '01.md'), '# Ouverture\n\nTEXTEPRESENT.\n');
    const service = new WordExportService();
    vi.spyOn(
      service as unknown as { checkPandoc: () => Promise<boolean> },
      'checkPandoc'
    ).mockResolvedValue(false);

    const result = await service.exportToWord({
      projectPath,
      projectType: 'book',
      content: '',
      outputPath: join(projectPath, 'livre.docx'),
      metadata: { title: 'Livre' },
      manuscript: {
        chapters: [
          { id: 'a', title: 'Ouverture', filePath: 'chapters/01.md', order: 0 },
          { id: 'b', title: 'Disparu', filePath: 'chapters/02.md', order: 1 },
        ],
      },
    });

    expect(result, result.error).toMatchObject({ success: true });
    expect(result.warnings).toEqual([
      { code: 'export.chapterUnreadable', params: { title: 'Disparu', file: 'chapters/02.md' } },
    ]);
    const zip = new PizZip(readFileSync(join(projectPath, 'livre.docx')));
    expect(plain(zip.file('word/document.xml')?.asText() ?? '')).toContain('TEXTEPRESENT');
  });
});

/**
 * Relevé par L07-2 : le générateur interne ne sait pas insérer une image ; il la remplaçait par sa
 * légende, sans un mot. La réserve la nomme.
 */
describe('images sur le chemin interne', () => {
  it('une image remplacée par sa légende est nommée', async () => {
    const { document, warnings } = await exportNative('Avant.\n\n![Carte des archives](images/carte.png)\n\nAprès.\n');

    expect(plain(document)).toContain('Carte des archives');
    expect(warnings).toContainEqual({
      code: 'export.word.imagesNotEmbedded',
      params: { files: 'images/carte.png', count: 1 },
    });
  });

  it('sans image, aucune réserve', async () => {
    const { warnings } = await exportNative('Un texte sans image.\n');

    expect(warnings).toBeUndefined();
  });
});

describe('résumé et diagnostics', () => {
  it('splitAbstract sépare titre et texte', () => {
    expect(splitAbstract('# Résumé\n\nTexte.')).toEqual({ heading: 'Résumé', body: 'Texte.' });
    expect(splitAbstract('## Zusammenfassung ##\nText.')).toEqual({
      heading: 'Zusammenfassung',
      body: 'Text.',
    });
    expect(splitAbstract('Texte sans titre.\n')).toEqual({ body: 'Texte sans titre.' });
  });

  it('pandocUnresolvedCitations lit les avertissements de citeproc', () => {
    const stderr =
      '[WARNING] Citeproc: citation Fantome_1999 not found\n' +
      '[WARNING] Citeproc: citation Fantome_1999 not found\n' +
      '[WARNING] Citeproc: citation autre:2020 not found\n';
    expect(pandocUnresolvedCitations(stderr)).toEqual(['Fantome_1999', 'autre:2020']);
  });
});

/**
 * Cause première du bug : le moteur cherchait ses styles à un chemin relatif
 * qui n'existe que depuis les sources. Dans l'app construite, aucun style
 * n'était trouvé et toutes les citations étaient comptées introuvables.
 */
describe('emplacement des styles CSL', () => {
  it('le dossier par défaut existe et contient les styles proposés', () => {
    const root = defaultCSLResourcesRoot();
    expect(existsSync(join(root, 'chicago-note-bibliography.csl'))).toBe(true);
    expect(new CitationEngine().stylePath('chicago-note-bibliography')).toBeDefined();
    expect(new CitationEngine().stylePath('style-inexistant')).toBeUndefined();
  });

  it('distingue un style à notes d’un style auteur-date', () => {
    const engine = new CitationEngine();
    expect(engine.isNoteStyle('chicago-note-bibliography')).toBe(true);
    expect(engine.isNoteStyle('modern-language-association')).toBe(false);
  });
});
