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
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import PizZip from 'pizzip';
import { WordExportService, type WordExportOptions } from '../word-export';
import { bibliographyService } from '../bibliography-service';
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
