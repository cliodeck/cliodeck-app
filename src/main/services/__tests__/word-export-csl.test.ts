/**
 * BT1-4 : un style CSL choisi par l'historien s'applique à l'export Word, ou
 * l'export dit pourquoi il ne s'applique pas.
 *
 * Vu en test : « l'export Word n'applique pas le style. Les styles intégrés
 * fonctionnent à peu près, mais pas les styles externes. » Quand `--csl`
 * arrive à pandoc, le style s'applique. Le CSL du projet était écarté en
 * silence ailleurs : bibliographie inconnue du renderer (importée pendant la
 * séance), donc générateur interne, qui ne lisait que les styles embarqués ;
 * fichier absent, retiré de la ligne de commande sans un mot.
 *
 * Le style `marqueur.csl`, écrit ici, préfixe chaque citation par
 * `[[MARQUEUR` : sa présence dans le texte du .docx, relu par `pandoc -t
 * plain` ou dans son XML, dit que c'est bien lui qui a rendu les citations.
 * Style indépendant : un style « dépendant » ferait télécharger son parent.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import PizZip from 'pizzip';
import { WordExportService, type WordExportOptions } from '../word-export';
import { bibliographyService } from '../bibliography-service';
import { documentDate } from '../pandoc-args';
import { DEFAULT_BOOK_SETTINGS, type BookSettings } from '../../../../backend/types/book';
import { setLanguage } from '../../i18n';
import { pandocAvailable } from '../../../../backend/__tests__/helpers/native-guards';

vi.setConfig({ testTimeout: 60_000 });

const MARQUEUR_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">
  <info>
    <title>Marqueur</title>
    <id>http://cliodeck.invalid/styles/marqueur</id>
    <updated>2026-11-08T00:00:00+00:00</updated>
  </info>
  <citation>
    <layout prefix="[[MARQUEUR " suffix="]]" delimiter="; ">
      <names variable="author"><name form="short"/></names>
    </layout>
  </citation>
  <bibliography>
    <layout>
      <text value="MARQUEUR-BIB "/>
      <names variable="author"><name/></names>
      <text variable="title" prefix=", "/>
    </layout>
  </bibliography>
</style>
`;

/**
 * Un style « dépendant », comme la plupart des styles de revue du dépôt
 * Zotero : un simple renvoi à son parent, sans citation ni bibliographie.
 * Pandoc irait chercher le parent en ligne ; le moteur interne rendait
 * `[NO_PRINTED_FORM]` à la place de chaque citation. Écrit ici : aucun
 * téléchargement.
 */
const DEPENDANT_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" default-locale="fr-FR">
  <info>
    <title>Revue dépendante</title>
    <id>http://cliodeck.invalid/styles/revue-dependante</id>
    <link href="http://cliodeck.invalid/styles/revue-dependante" rel="self"/>
    <link href="http://cliodeck.invalid/styles/parent" rel="independent-parent"/>
    <category citation-format="numeric"/>
    <updated>2026-11-08T00:00:00+00:00</updated>
  </info>
</style>
`;

/**
 * Un style qui numérote comme IEEE : `[1]` renvoie à la première référence
 * citée, `[2]` à la deuxième. Le numéro d'une citation dépend donc de tout le
 * document. Écrit ici : aucun téléchargement.
 */
const NUMEROTE_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">
  <info>
    <title>Numéroté</title>
    <id>http://cliodeck.invalid/styles/numerote</id>
    <category citation-format="numeric"/>
    <updated>2026-11-08T00:00:00+00:00</updated>
  </info>
  <citation collapse="citation-number">
    <sort><key variable="citation-number"/></sort>
    <layout prefix="[" suffix="]" delimiter=", ">
      <text variable="citation-number"/>
    </layout>
  </citation>
  <bibliography>
    <layout>
      <text variable="citation-number" prefix="NUM-BIB [" suffix="] "/>
      <names variable="author"><name/></names>
      <text variable="title" prefix=", "/>
    </layout>
  </bibliography>
</style>
`;

/** Deux références, dans l'ordre : Farge, Ginzburg, Farge encore. */
const DEUX_REFERENCES = 'Farge [@farge1989] puis Ginzburg [@ginzburg1980] puis Farge encore [@farge1989].\n';

/** Un style que citeproc-js ne sait pas lire : une balise jamais fermée. */
const ILLISIBLE_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">
  <info><title>Illisible</title><id>http://cliodeck.invalid/styles/illisible</id></info>
  <citation>
    <layout prefix="[[X " suffix="]]">
      <names variable="author"><name/></names><text variable="title"
    </layout>
  </citation>
</style>
`;

const BIB = `@book{farge1989,
  author = {Farge, Arlette},
  title = {Le goût de l'archive},
  publisher = {Seuil},
  year = {1989}
}

@book{ginzburg1980,
  author = {Ginzburg, Carlo},
  title = {Le fromage et les vers},
  publisher = {Flammarion},
  year = {1980}
}
`;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cliodeck-word-csl-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Un projet tel que le main l'a écrit : `project.json` déclare la
 * bibliographie et le style par des chemins relatifs, les fichiers sont à la
 * racine. `type: 'book'` pose trois chapitres ; `bibliography: false`, un
 * projet qui n'a pas encore de bibliographie.
 */
function makeProject(type: 'article' | 'book', { bibliography = true } = {}): string {
  const projectPath = mkdtempSync(join(dir, `${type}-`));
  if (bibliography) writeFileSync(join(projectPath, 'references.bib'), BIB);
  writeFileSync(join(projectPath, 'marqueur.csl'), MARQUEUR_CSL);
  const manifest: Record<string, unknown> = {
    name: 'Essai',
    type,
    ...(bibliography ? { bibliographySource: { type: 'file', filePath: 'references.bib' } } : {}),
    cslPath: 'marqueur.csl',
  };
  if (type === 'book') {
    mkdirSync(join(projectPath, 'chapters'));
    manifest.chapters = [1, 2, 3].map((n) => ({
      id: `c${n}`,
      title: `Chapitre ${n}`,
      filePath: `chapters/0${n}-chapitre.md`,
      order: n - 1,
    }));
    for (const n of [1, 2, 3]) {
      writeFileSync(join(projectPath, `chapters/0${n}-chapitre.md`), `# Chapitre ${n}\n\nTexte ${n}.\n`);
    }
  }
  writeFileSync(join(projectPath, 'project.json'), JSON.stringify(manifest, null, 2));
  return projectPath;
}

/** Les options qu'envoie la modale Word, case « style intégré » décochée. */
function articleOptions(projectPath: string): WordExportOptions {
  return {
    projectPath,
    projectType: 'article',
    content: 'Comme le montre Farge [@farge1989], l’archive se lit.\n',
    outputPath: join(projectPath, 'sortie.docx'),
    bibliographyPath: join(projectPath, 'references.bib'),
    cslPath: join(projectPath, 'marqueur.csl'),
    metadata: { title: 'Essai', author: 'Autrice' },
    citation: { useEngine: false, style: 'chicago-note-bibliography', locale: 'fr-FR' },
  };
}

/** Le texte du .docx, tel qu'un lecteur le voit. */
function docxText(outputPath: string): string {
  return execFileSync('pandoc', ['-t', 'plain', '--wrap=none', outputPath], { encoding: 'utf8' });
}

describe.skipIf(!pandocAvailable())('export Word par pandoc : le style CSL du projet', () => {
  it('article : le style du projet rend les citations (témoin)', async () => {
    const projectPath = makeProject('article');
    const options = articleOptions(projectPath);

    const result = await new WordExportService().exportToWord(options);

    expect(result).toMatchObject({ success: true });
    expect(docxText(options.outputPath!)).toContain('[[MARQUEUR Farge]]');
  });

  it('livre, chapitre 3 ouvert : le style s’applique au texte vivant (témoin)', async () => {
    const projectPath = makeProject('book');
    const manifest = JSON.parse(readFileSync(join(projectPath, 'project.json'), 'utf8'));
    const options: WordExportOptions = {
      ...articleOptions(projectPath),
      projectType: 'book',
      content: '',
      manuscript: {
        chapters: manifest.chapters,
        liveOverrides: {
          'chapters/03-chapitre.md': '# Chapitre 3\n\nFrappe vivante, selon [@farge1989].\n',
        },
        scope: { chapterId: 'c3' },
      },
    };

    const result = await new WordExportService().exportToWord(options);

    expect(result).toMatchObject({ success: true });
    const text = docxText(options.outputPath!);
    expect(text).toContain('Frappe vivante');
    expect(text).toContain('[[MARQUEUR Farge]]');
  });

  it('case « style intégré » cochée : le style choisi l’emporte sur celui du projet', async () => {
    const projectPath = makeProject('article');
    const options: WordExportOptions = {
      ...articleOptions(projectPath),
      citation: { useEngine: true, style: 'chicago-note-bibliography', locale: 'fr-FR' },
    };

    const result = await new WordExportService().exportToWord(options);

    expect(result).toMatchObject({ success: true });
    const text = docxText(options.outputPath!);
    expect(text).not.toContain('MARQUEUR');
    expect(text).not.toContain('@farge1989');
    expect(result).not.toHaveProperty('missingCsl');
  });

  it('bibliographie importée pendant la séance, inconnue du renderer : le main la lit dans project.json', async () => {
    const projectPath = makeProject('article');
    const { bibliographyPath: _figee, ...options } = articleOptions(projectPath);

    const result = await new WordExportService().exportToWord(options);

    expect(result).toMatchObject({ success: true });
    const text = docxText(options.outputPath!);
    expect(text).not.toContain('@farge1989');
    expect(text).toContain('[[MARQUEUR Farge]]');
  });

  it('style déclaré mais absent : l’export aboutit et le dit', async () => {
    const projectPath = makeProject('article');
    rmSync(join(projectPath, 'marqueur.csl'));
    const options = articleOptions(projectPath);

    const result = await new WordExportService().exportToWord(options);

    expect(result).toMatchObject({ success: true, missingCsl: join(projectPath, 'marqueur.csl') });
  });

  it('style absent, chemin relatif tel que l’ouverture l’a laissé : l’export le dit aussi', async () => {
    const projectPath = makeProject('article');
    rmSync(join(projectPath, 'marqueur.csl'));
    const options: WordExportOptions = { ...articleOptions(projectPath), cslPath: 'marqueur.csl' };

    const result = await new WordExportService().exportToWord(options);

    expect(result).toMatchObject({ success: true, missingCsl: join(projectPath, 'marqueur.csl') });
  });

  it('style numéroté : pandoc numérote dans l’ordre des références citées (témoin)', async () => {
    const projectPath = makeProject('article');
    writeFileSync(join(projectPath, 'marqueur.csl'), NUMEROTE_CSL);
    const options: WordExportOptions = { ...articleOptions(projectPath), content: DEUX_REFERENCES };

    const result = await new WordExportService().exportToWord(options);

    expect(result).toMatchObject({ success: true });
    expect(result).not.toHaveProperty('unusableCsl');
    expect(docxText(options.outputPath!)).toContain('Farge [1] puis Ginzburg [2] puis Farge encore [1]');
  });
});

/**
 * Sans pandoc, le générateur interne : son moteur de citations ne chargeait
 * que les styles embarqués, par leur nom. Case décochée, il ne tournait même
 * pas, et le .docx gardait les clés.
 */
describe('export Word sans pandoc : le moteur interne et le style du projet', () => {
  beforeAll(async () => {
    await bibliographyService.parseContent(BIB);
  });

  async function exportNative(options: WordExportOptions) {
    const service = new WordExportService();
    vi.spyOn(
      service as unknown as { checkPandoc: () => Promise<boolean> },
      'checkPandoc'
    ).mockResolvedValue(false);
    const result = await service.exportToWord(options);
    const zip = new PizZip(readFileSync(options.outputPath!));
    const text = (zip.file('word/document.xml')?.asText() ?? '').replace(/<[^>]+>/g, '');
    return { result, text };
  }

  it('case décochée : le moteur rend les citations dans le style du projet', async () => {
    const { result, text } = await exportNative(articleOptions(makeProject('article')));

    expect(result).toMatchObject({ success: true });
    expect(text).toContain('[[MARQUEUR Farge]]');
    expect(text).not.toContain('@farge1989');
  });

  it('case cochée : le style intégré choisi, comme avant', async () => {
    const { result, text } = await exportNative({
      ...articleOptions(makeProject('article')),
      citation: { useEngine: true, style: 'chicago-note-bibliography', locale: 'fr-FR' },
    });

    expect(result).toMatchObject({ success: true });
    expect(text).not.toContain('MARQUEUR');
    expect(text).not.toContain('@farge1989');
  });

  it('style déclaré mais absent : l’export le dit', async () => {
    const projectPath = makeProject('article');
    rmSync(join(projectPath, 'marqueur.csl'));

    const { result } = await exportNative(articleOptions(projectPath));

    expect(result).toMatchObject({ success: true, missingCsl: join(projectPath, 'marqueur.csl') });
  });

  it('style dépendant : les clés restent, et l’export dit pourquoi', async () => {
    const projectPath = makeProject('article');
    const stylePath = join(projectPath, 'marqueur.csl');
    writeFileSync(stylePath, DEPENDANT_CSL);

    const { result, text } = await exportNative(articleOptions(projectPath));

    expect(text).not.toContain('NO_PRINTED_FORM');
    expect(text).toContain('[@farge1989]');
    expect(result).toMatchObject({
      success: true,
      unusableCsl: { path: stylePath, reason: 'dependent' },
    });
    expect(result).not.toHaveProperty('unresolvedCitations');
  });

  it('style que le moteur ne sait pas lire : les clés restent, et l’export le dit', async () => {
    const projectPath = makeProject('article');
    const stylePath = join(projectPath, 'marqueur.csl');
    writeFileSync(stylePath, ILLISIBLE_CSL);

    const { result, text } = await exportNative(articleOptions(projectPath));

    expect(text).toContain('[@farge1989]');
    expect(result).toMatchObject({
      success: true,
      unusableCsl: { path: stylePath, reason: 'unreadable' },
    });
    // La clé existe : la dire « introuvable » tromperait l'auteur.
    expect(result).not.toHaveProperty('unresolvedCitations');
  });

  it('style numéroté : pas de numéro faux, les clés restent, et l’export dit pourquoi', async () => {
    // Le moteur rend chaque groupe à part : chaque citation y recevait le
    // numéro 1, et `[1]` après Ginzburg renvoyait à Farge dans la liste.
    const projectPath = makeProject('article');
    const stylePath = join(projectPath, 'marqueur.csl');
    writeFileSync(stylePath, NUMEROTE_CSL);

    const { result, text } = await exportNative({ ...articleOptions(projectPath), content: DEUX_REFERENCES });

    expect(text).not.toContain('Ginzburg [1]');
    expect(text).toContain('Farge [@farge1989] puis Ginzburg [@ginzburg1980]');
    expect(result).toMatchObject({
      success: true,
      unusableCsl: { path: stylePath, reason: 'numeric' },
    });
    expect(result).not.toHaveProperty('unresolvedCitations');
  });

  it('projet sans bibliographie : ses citations ne viennent pas de celle restée en mémoire', async () => {
    // La bibliographie chargée plus haut joue celle d'un projet ouvert avant
    // (le service n'est pas vidé au changement de projet, S07-1-31). Pandoc
    // n'applique `--csl` qu'avec `--bibliography` : le moteur fait de même.
    const projectPath = makeProject('article', { bibliography: false });
    const { bibliographyPath: _aucune, ...options } = articleOptions(projectPath);

    const { result, text } = await exportNative(options);

    expect(result).toMatchObject({ success: true });
    expect(text).toContain('[@farge1989]');
    expect(text).not.toContain('MARQUEUR');
  });
});

/**
 * L10-4 (S18-1-3, Q42) : le document fait foi, en Word comme en PDF. Le champ Auteur laissé vide
 * envoyait « ClioDesk », la fenêtre imposait la date du jour en français, et le titre de la
 * bibliographie partait en `--metadata`, qui l'emporte sur le front matter. Vrai pandoc : le
 * `.docx` produit est relu (texte du document, propriétés).
 */
describe.skipIf(!pandocAvailable())('export Word par pandoc : le document fait foi (L10-4)', () => {
  afterEach(() => setLanguage('fr'));

  /** Le texte du document et ses propriétés, tels que Word les lit. */
  function readDocx(outputPath: string): { text: string; document: string; core: string } {
    const zip = new PizZip(readFileSync(outputPath));
    const document = zip.file('word/document.xml')?.asText() ?? '';
    return { text: document.replace(/<[^>]+>/g, ' '), document, core: zip.file('docProps/core.xml')?.asText() ?? '' };
  }

  it('front matter : son auteur, sa date et son titre de bibliographie ; le résumé garde son italique', async () => {
    const projectPath = makeProject('article');
    writeFileSync(join(projectPath, 'abstract.md'), '# Résumé\n\nUn *ABSITAL* chez Dupont & Fils.\n');
    const options: WordExportOptions = {
      ...articleOptions(projectPath),
      content:
        '---\nauthor: Frédéric Clavert\ndate: 1er mai 1968\nreference-section-title: Sources citées\n---\n\n' +
        'Comme le montre Farge [@farge1989].\n',
      metadata: { title: 'Essai' },
    };

    const result = await new WordExportService().exportToWord(options);

    expect(result, result.error).toMatchObject({ success: true });
    const { text, document, core } = readDocx(options.outputPath!);
    expect(text).toContain('Frédéric Clavert');
    expect(text).toContain('1er mai 1968');
    expect(text).toContain('Sources citées');
    expect(text).not.toContain('Références');
    expect(text).toContain('Dupont &amp; Fils');
    expect(text).not.toContain('*ABSITAL*');
    expect(document).toMatch(/<w:i ?\/>(?:(?!<\/w:r>).)*ABSITAL/s);
    expect(core).not.toMatch(/ClioDes[kc]/);
  });

  it('sans date dans le document : la date du jour, dans la langue de l’interface ; l’auteur saisi l’emporte', async () => {
    setLanguage('de');
    const projectPath = makeProject('article');
    const options: WordExportOptions = {
      ...articleOptions(projectPath),
      content: '---\nauthor: Frédéric Clavert\n---\n\nComme le montre Farge [@farge1989].\n',
      metadata: { title: 'Essai', author: 'Autrice saisie' },
    };

    const before = documentDate(new Date());
    const result = await new WordExportService().exportToWord(options);
    const after = documentDate(new Date());

    expect(result, result.error).toMatchObject({ success: true });
    const { text } = readDocx(options.outputPath!);
    expect([before, after].some((date) => text.includes(date))).toBe(true);
    expect(text).toContain('Autrice saisie');
    expect(text).not.toContain('Frédéric Clavert');
    expect(text).toContain('Literatur');
  });

  it('article neuf : le texte de remplissage d’abstract.md ne s’imprime pas', async () => {
    const projectPath = makeProject('article');
    // Ce qu'écrit `project-manager` à la création d'un article.
    writeFileSync(join(projectPath, 'abstract.md'), '# Résumé\n\nRésumé à compléter...');
    const options: WordExportOptions = { ...articleOptions(projectPath), metadata: { title: 'Essai' } };

    const result = await new WordExportService().exportToWord(options);

    expect(result, result.error).toMatchObject({ success: true });
    expect(readDocx(options.outputPath!).text).not.toContain('compléter');
  });
});

/**
 * S12-1-5 : l'export Word d'un livre par pandoc passait `--number-sections` dès que les chapitres
 * se numérotaient. Dans un .docx, cette option numérote tous les niveaux (`secnumdepth` n'y fait
 * rien) : avec les réglages par défaut, « 1 Premier », puis « 1.1 Section A », « 1.1.1 ». Vrai
 * pandoc : le numéro d'un titre est le texte de son segment `SectionNumber`, dans
 * `word/document.xml`. Le titre de la bibliographie, que pandoc marque `unnumbered`, n'en reçoit
 * jamais.
 */
describe.skipIf(!pandocAvailable())('export Word par pandoc d’un livre : numérotation des titres (S12-1-5)', () => {
  const savedTmpdir = process.env.TMPDIR;
  afterEach(() => {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
  });

  /** Les titres du document, dans l'ordre : style, numéro (`SectionNumber`), texte. */
  function headings(outputPath: string): string[] {
    const document = new PizZip(readFileSync(outputPath)).file('word/document.xml')?.asText() ?? '';
    const numberRun = /<w:r><w:rPr><w:rStyle w:val="SectionNumber" ?\/><\/w:rPr><w:t[^>]*>([^<]*)<\/w:t><\/w:r>/;
    return [...document.matchAll(/<w:p[ >](?:(?!<\/w:p>)[\s\S])*<\/w:p>/g)].flatMap(([p]) => {
      const style = p.match(/<w:pStyle w:val="(Heading\d)" ?\/>/)?.[1];
      if (!style) return [];
      const number = p.match(numberRun)?.[1];
      const text = p.replace(numberRun, '').replace(/<[^>]+>/g, '').trim();
      return [`${style} ${number ?? '-'} ${text}`];
    });
  }

  /** Un livre de trois chapitres, avec sections et sous-sections, qui cite une référence. */
  function bookOptions(settings: Partial<BookSettings>): WordExportOptions {
    const projectPath = makeProject('book');
    const texts = [
      '# Premier\n\nTexte, selon [@farge1989].\n\n## Section A\n\nTexte.\n\n### Sous-section A\n\nTexte.\n',
      '# Second\n\n## Section B\n\nTexte.\n',
      '# Troisième\n\nTexte.\n',
    ];
    texts.forEach((text, i) => writeFileSync(join(projectPath, `chapters/0${i + 1}-chapitre.md`), text));
    const manifest = JSON.parse(readFileSync(join(projectPath, 'project.json'), 'utf8'));
    return {
      ...articleOptions(projectPath),
      projectType: 'book',
      content: '',
      bookSettings: { ...DEFAULT_BOOK_SETTINGS, ...settings },
      manuscript: { chapters: manifest.chapters },
    };
  }

  /** Les titres attendus, `-` pour un titre sans numéro. */
  const chaptersOnly = [
    'Heading1 1 Premier',
    'Heading2 - Section A',
    'Heading3 - Sous-section A',
    'Heading1 2 Second',
    'Heading2 - Section B',
    'Heading1 3 Troisième',
    'Heading1 - Références',
  ];
  const chaptersAndSections = [
    'Heading1 1 Premier',
    'Heading2 1.1 Section A',
    'Heading3 - Sous-section A',
    'Heading1 2 Second',
    'Heading2 2.1 Section B',
    'Heading1 3 Troisième',
    'Heading1 - Références',
  ];

  it.each([
    ['réglages par défaut : chapitres numérotés, sections sans numéro', {}, chaptersOnly],
    ['« Numéroter les sections » : chapitres et sections', { numberSections: true }, chaptersAndSections],
    [
      'sections sans chapitres : les chapitres aussi, comme dans le PDF',
      { numberChapters: false, numberSections: true },
      chaptersAndSections,
    ],
    [
      'rien de coché : aucun numéro',
      { numberChapters: false },
      chaptersOnly.map((h) => h.replace(/^(Heading\d) \S+/, '$1 -')),
    ],
  ] as const)('%s', async (_label, settings, expected) => {
    const options = bookOptions(settings);

    const result = await new WordExportService().exportToWord(options);

    expect(result, result.error).toMatchObject({ success: true });
    expect(headings(options.outputPath!)).toEqual(expected);
  });

  /**
   * Liminaires et pièces finales (`kind: 'front'` et `'back'`, réglés dans `project.json`) : le PDF
   * ne les numérote pas (`\frontmatter`, `\backmatter`). Dans le Word, `--number-sections` les
   * numérotait, et le filtre ne retirait le numéro qu'aux niveaux trop profonds : l'avant-propos
   * devenait « 1 », le premier vrai chapitre « 2 », l'annexe « 4 ».
   */
  function bookWithMatterOptions(settings: Partial<BookSettings>): WordExportOptions {
    const projectPath = makeProject('book');
    const pieces = [
      { id: 'f', kind: 'front', text: '# Avant-propos\n\nTexte.\n\n## Remerciements\n\nMerci.\n' },
      { id: 'c1', kind: 'chapter', text: '# Premier\n\nTexte, selon [@farge1989].\n\n## Section A\n\nTexte.\n' },
      { id: 'c2', kind: 'chapter', text: '# Second\n\n## Section B\n\nTexte.\n' },
      { id: 'b', kind: 'back', text: '# Annexe\n\n## Pièce 1\n\nTexte.\n' },
    ] as const;
    pieces.forEach((p) => writeFileSync(join(projectPath, `chapters/${p.id}.md`), p.text));
    return {
      ...articleOptions(projectPath),
      projectType: 'book',
      content: '',
      bookSettings: { ...DEFAULT_BOOK_SETTINGS, ...settings },
      manuscript: {
        chapters: pieces.map((p, order) => ({
          id: p.id,
          kind: p.kind,
          title: p.id,
          filePath: `chapters/${p.id}.md`,
          order,
        })),
      },
    };
  }

  it.each([
    [
      'réglages par défaut',
      {},
      [
        'Heading1 - Avant-propos',
        'Heading2 - Remerciements',
        'Heading1 1 Premier',
        'Heading2 - Section A',
        'Heading1 2 Second',
        'Heading2 - Section B',
        'Heading1 - Annexe',
        'Heading2 - Pièce 1',
        'Heading1 - Références',
      ],
    ],
    [
      '« Numéroter les sections »',
      { numberSections: true },
      [
        'Heading1 - Avant-propos',
        'Heading2 - Remerciements',
        'Heading1 1 Premier',
        'Heading2 1.1 Section A',
        'Heading1 2 Second',
        'Heading2 2.1 Section B',
        'Heading1 - Annexe',
        'Heading2 - Pièce 1',
        'Heading1 - Références',
      ],
    ],
  ] as const)('liminaires et pièces finales sans numéro, comme dans le PDF : %s', async (_label, settings, expected) => {
    const options = bookWithMatterOptions(settings);

    const result = await new WordExportService().exportToWord(options);

    expect(result, result.error).toMatchObject({ success: true });
    expect(headings(options.outputPath!)).toEqual(expected);
  });

  it('le filtre est écrit dans le dossier de travail de l’export, dont le chemin a une espace, et part avec lui', async () => {
    const spaced = join(dir, 'dossier temporaire');
    mkdirSync(spaced);
    process.env.TMPDIR = spaced;
    const options = bookOptions({});

    const result = await new WordExportService().exportToWord(options);

    expect(result, result.error).toMatchObject({ success: true });
    expect(headings(options.outputPath!)).toEqual(chaptersOnly);
    expect(readdirSync(spaced)).toEqual([]);
  });
});
