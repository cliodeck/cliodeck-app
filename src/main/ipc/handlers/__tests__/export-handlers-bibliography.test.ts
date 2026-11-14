/**
 * L04-8 (S18-2-2) : les exports Word et PDF des fenêtres prennent la bibliographie que déclare
 * `project.json` au moment de l'export, et non celle que transmet le renderer, figée à
 * l'ouverture du projet (`currentProject.bibliography`).
 *
 * Vu : projet article neuf, première synchronisation Zotero ou import d'un `.bib`, une citation
 * `[@dupont2020]`, export sans rouvrir le projet : le document gardait la clé brute, sans
 * bibliographie, et la fenêtre annonçait un succès. Rouvert, le projet exportait la citation mise
 * en forme. BT1-4 avait réglé le Word dans son service ; le PDF lançait encore pandoc sans
 * `--citeproc`.
 *
 * Un `.bib` que `project.json` nomme et qui manque (H3, J1) n'est pas remplacé par celui du
 * renderer : l'export se fait sans bibliographie, et le dit (`export.bibliographyMissing`) quand des
 * citations en restent telles quelles. Sans citation, ou toutes rendues par le style intégré, il
 * sortirait identique avec lui : rien à dire (revue de L04-8).
 *
 * Les vrais handlers, la vraie validation, les vrais services d'export ; seul Electron est simulé,
 * et le gestionnaire de projets, pour jouer un autre projet ouvert pendant l'export. Les exports
 * par pandoc et xelatex sont relus dans le fichier produit (pdftotext, `pandoc -t plain`) et sautés
 * sans ces outils, comme en CI. Le générateur Word interne tourne partout.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import PizZip from 'pizzip';
import { readExportWarnings } from '../../../../renderer/src/components/Export/ExportWarnings';
import { wordExportService } from '../../../services/word-export.js';
import { bibliographyService } from '../../../services/bibliography-service.js';
import { DEFAULT_BOOK_SETTINGS } from '../../../../../backend/types/book.js';
import {
  pandocAvailable,
  pdftotextAvailable,
  toolEnv,
  xelatexAvailable,
} from '../../../../../backend/__tests__/helpers/native-guards.js';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  /** Le projet que le main tient pour ouvert : un autre que celui de l'export, dans la bascule. */
  current: null as string | null,
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { fromWebContents: () => null },
  powerMonitor: { on: () => undefined },
}));
// Hors sujet ici, et son module parle à Electron au-delà de ce que le banc simule.
vi.mock('../../../services/revealjs-export.js', () => ({ revealJsExportService: {} }));
// Rien de l'export ne doit le lire : le projet de l'export est celui de la demande.
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: {
    getCurrentProjectPath: () => h.current,
    getCurrentProject: () =>
      h.current
        ? {
            path: h.current,
            bibliography: join(h.current, 'refs.bib'),
            bibliographySource: { type: 'file', filePath: 'refs.bib' },
          }
        : null,
  },
}));

import { setupExportHandlers } from '../export-handlers.js';

/** Large : xelatex charge les polices du système à chaque compilation. */
const COMPILE_MS = 120_000;

function reference(title: string): string {
  return `@book{dupont2020,
  author = {Dupont, Jean},
  title = {${title}},
  year = {2020},
  publisher = {Éditions du banc}
}
`;
}

/** Le `.bib` que nomme `project.json`, rattaché pendant la séance. En minuscules, comme les textes relus. */
const TITRE = 'une histoire des archives';
/** Le `.bib` d'avant, qu'un import a remplacé : même clé, autre titre. */
const ANCIEN_TITRE = 'un ancien titre remplacé';
/** Le `.bib` d'un autre projet, ouvert pendant l'export. */
const TITRE_B = 'la bibliographie du projet b';

const TEXTE = 'Comme le montre Dupont [@dupont2020], l’archive se lit.\n';

/** Un style indépendant qui signe ses citations : sa présence dit que le style du projet a rendu. */
const MARQUEUR_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">
  <info>
    <title>Marqueur</title>
    <id>http://cliodeck.invalid/styles/marqueur</id>
    <updated>2026-11-14T00:00:00+00:00</updated>
  </info>
  <citation>
    <layout prefix="[[MARQUEUR " suffix="]]" delimiter="; ">
      <names variable="author"><name form="short"/></names>
    </layout>
  </citation>
  <bibliography>
    <layout>
      <text value="MARQUEUR-BIB "/>
      <text variable="title"/>
    </layout>
  </bibliography>
</style>
`;

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cliodeck-export-bib-'));
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  h.handlers.clear();
  h.current = null;
  setupExportHandlers();
});
afterEach(() => {
  vi.restoreAllMocks();
  bibliographyService.forget();
});

/**
 * Un projet tel que le main l'écrit : `project.json` nomme son `.bib` par un chemin relatif
 * (`declared`, `null` : aucune source), `refs.bib` est écrit s'il a un titre, et l'ancien `.bib`
 * reste à côté, comme après un import qui l'a remplacé sous un autre nom.
 */
function makeProject(
  type: 'article' | 'book',
  { declared = 'refs.bib' as string | null, title = TITRE as string | null } = {}
): string {
  const project = mkdtempSync(join(root, `${type}-`));
  if (title) writeFileSync(join(project, 'refs.bib'), reference(title));
  writeFileSync(join(project, 'ancien.bib'), reference(ANCIEN_TITRE));
  writeFileSync(
    join(project, 'project.json'),
    JSON.stringify(
      {
        name: 'Essai',
        type,
        ...(declared ? { bibliographySource: { type: 'file', filePath: declared } } : {}),
      },
      null,
      2
    )
  );
  return project;
}

/** Ce qu'envoient les fenêtres d'export : `currentProject`, figé à l'ouverture du projet. */
function windowOptions(project: string, outputName: string, extra: Record<string, unknown> = {}) {
  return {
    projectPath: project,
    projectType: 'article',
    content: TEXTE,
    outputPath: join(project, outputName),
    metadata: { title: 'Essai', author: 'Autrice' },
    citation: { useEngine: false, style: 'chicago-note-bibliography', locale: 'fr-FR' },
    ...extra,
  };
}

async function call(channel: string, options: Record<string, unknown>) {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`handler absent : ${channel}`);
  const response = (await handler({ sender: {} }, options)) as { success?: boolean; error?: string };
  return { response, reserves: readExportWarnings(response) };
}

/**
 * Le texte du PDF, en minuscules et espaces ramenées à une seule : le style par défaut de pandoc
 * met les titres en capitales (« Une Histoire Des Archives »).
 */
function pdfText(pdf: string): string {
  return execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8', env: toolEnv() }).replace(/\s+/g, ' ').toLowerCase();
}

/** Le texte du .docx, tel qu'un lecteur le voit, en minuscules comme celui du PDF. */
function docxText(docx: string): string {
  return execFileSync('pandoc', ['-t', 'plain', '--wrap=none', docx], { encoding: 'utf8', env: toolEnv() }).toLowerCase();
}

const missing = (project: string) => ({
  code: 'export.bibliographyMissing',
  params: { file: join(project, 'refs.bib') },
});

describe.skipIf(!pandocAvailable() || !xelatexAvailable() || !pdftotextAvailable())(
  'pdf-export:export : la bibliographie du projet, relue à l’export',
  () => {
    it(
      'rattachée pendant la séance, inconnue du renderer : citation et bibliographie mises en forme',
      async () => {
        const project = makeProject('article');

        const { response, reserves } = await call('pdf-export:export', windowOptions(project, 'article.pdf'));

        expect(response, response.error).toMatchObject({ success: true });
        expect(reserves.unresolvedCitations).toEqual([]);
        const text = pdfText(join(project, 'article.pdf'));
        expect(text).not.toContain('@dupont2020');
        expect(text).toContain(TITRE);
      },
      COMPILE_MS
    );

    it(
      'l’ancien chemin transmis après un remplacement : le fichier que nomme project.json l’emporte',
      async () => {
        const project = makeProject('article');

        const { response } = await call(
          'pdf-export:export',
          windowOptions(project, 'article.pdf', { bibliographyPath: join(project, 'ancien.bib') })
        );

        expect(response, response.error).toMatchObject({ success: true });
        const text = pdfText(join(project, 'article.pdf'));
        expect(text).toContain(TITRE);
        expect(text).not.toContain(ANCIEN_TITRE);
      },
      COMPILE_MS
    );

    it(
      'aucune source dans project.json : la bibliographie du renderer sert, comme avant (témoin)',
      async () => {
        const project = makeProject('article', { declared: null });

        const { response } = await call(
          'pdf-export:export',
          windowOptions(project, 'article.pdf', { bibliographyPath: join(project, 'ancien.bib') })
        );

        expect(response, response.error).toMatchObject({ success: true });
        expect(pdfText(join(project, 'article.pdf'))).toContain(ANCIEN_TITRE);
      },
      COMPILE_MS
    );

    it(
      '.bib nommé par project.json et absent : le PDF sort sans lui, sans l’ancien, et la fenêtre le dit',
      async () => {
        const project = makeProject('article', { title: null });

        const { response, reserves } = await call(
          'pdf-export:export',
          windowOptions(project, 'article.pdf', { bibliographyPath: join(project, 'ancien.bib') })
        );

        expect(response, response.error).toMatchObject({ success: true });
        expect(reserves.issues).toContainEqual(missing(project));
        expect(reserves.unresolvedCitations).toEqual(['dupont2020']);
        const text = pdfText(join(project, 'article.pdf'));
        expect(text).not.toContain(ANCIEN_TITRE);
        expect(text).toContain('dupont2020');
      },
      COMPILE_MS
    );

    it(
      '.bib nommé et absent, document sans citation : le PDF sortirait identique avec lui, rien à dire',
      async () => {
        const project = makeProject('article', { title: null });

        const { response, reserves } = await call(
          'pdf-export:export',
          windowOptions(project, 'article.pdf', { content: 'Texte sans citation.\n' })
        );

        expect(response, response.error).toMatchObject({ success: true });
        expect(reserves).toMatchObject({ issues: [], unresolvedCitations: [] });
      },
      COMPILE_MS
    );

    it(
      '.bib nommé et absent, style intégré et références en mémoire : la citation est rendue, rien à dire',
      async () => {
        const project = makeProject('article', { title: null });
        await bibliographyService.parseContent(reference(TITRE));

        const { response, reserves } = await call(
          'pdf-export:export',
          windowOptions(project, 'article.pdf', {
            citation: { useEngine: true, style: 'chicago-note-bibliography', locale: 'fr-FR' },
          })
        );

        expect(response, response.error).toMatchObject({ success: true });
        expect(reserves).toMatchObject({ issues: [], unresolvedCitations: [] });
        const text = pdfText(join(project, 'article.pdf'));
        expect(text).not.toContain('dupont2020');
        expect(text).toContain(TITRE);
      },
      COMPILE_MS
    );

    it(
      '.bib nommé et absent, citation narrative seule (@clé nue) : le fichier est nommé (témoin)',
      async () => {
        const project = makeProject('article', { title: null });

        const { response, reserves } = await call(
          'pdf-export:export',
          windowOptions(project, 'article.pdf', { content: 'Comme le montre @dupont2020, l’archive se lit.\n' })
        );

        expect(response, response.error).toMatchObject({ success: true });
        expect(reserves.issues).toEqual([missing(project)]);
        expect(reserves.unresolvedCitations).toEqual([]);
        expect(pdfText(join(project, 'article.pdf'))).toContain('@dupont2020');
      },
      COMPILE_MS
    );

    it(
      'projet B ouvert pendant l’export de A : la bibliographie reste celle de A',
      async () => {
        const project = makeProject('article');
        h.current = makeProject('article', { title: TITRE_B });

        const { response } = await call('pdf-export:export', windowOptions(project, 'article.pdf'));

        expect(response, response.error).toMatchObject({ success: true });
        const text = pdfText(join(project, 'article.pdf'));
        expect(text).toContain(TITRE);
        expect(text).not.toContain(TITRE_B);
      },
      COMPILE_MS
    );

    it(
      'livre, bibliographie par chapitre : citeproc reçoit le .bib du projet avant l’assemblage',
      async () => {
        const project = makeProject('book');
        mkdirSync(join(project, 'chapters'));
        writeFileSync(join(project, 'chapters', '01.md'), `# Ouverture\n\n${TEXTE}`);

        const { response, reserves } = await call(
          'pdf-export:export',
          windowOptions(project, 'livre.pdf', {
            projectType: 'book',
            content: '',
            bookSettings: { ...DEFAULT_BOOK_SETTINGS, bibliography: 'per-chapter' },
            manuscript: { chapters: [{ id: 'c1', title: 'Ouverture', filePath: 'chapters/01.md', order: 0 }] },
          })
        );

        expect(response, response.error).toMatchObject({ success: true });
        expect(reserves.issues).toEqual([]);
        const text = pdfText(join(project, 'livre.pdf'));
        expect(text).not.toContain('@dupont2020');
        expect(text).toContain(TITRE);
      },
      COMPILE_MS
    );
  }
);

describe.skipIf(!pandocAvailable())('word-export:export par pandoc : la bibliographie du projet, relue à l’export', () => {
  it('rattachée pendant la séance, inconnue du renderer : citation et bibliographie mises en forme (témoin, BT1-4)', async () => {
    const project = makeProject('article');

    const { response, reserves } = await call('word-export:export', windowOptions(project, 'article.docx'));

    expect(response, response.error).toMatchObject({ success: true });
    expect(reserves.unresolvedCitations).toEqual([]);
    const text = docxText(join(project, 'article.docx'));
    expect(text).not.toContain('@dupont2020');
    expect(text).toContain(TITRE);
  });

  it('l’ancien chemin transmis après un remplacement : le fichier que nomme project.json l’emporte (témoin, BT1-4)', async () => {
    const project = makeProject('article');

    const { response } = await call(
      'word-export:export',
      windowOptions(project, 'article.docx', { bibliographyPath: join(project, 'ancien.bib') })
    );

    expect(response, response.error).toMatchObject({ success: true });
    const text = docxText(join(project, 'article.docx'));
    expect(text).toContain(TITRE);
    expect(text).not.toContain(ANCIEN_TITRE);
  });

  it('.bib nommé par project.json et absent : l’ancien ne le remplace pas, et la fenêtre le dit', async () => {
    const project = makeProject('article', { title: null });

    const { response, reserves } = await call(
      'word-export:export',
      windowOptions(project, 'article.docx', { bibliographyPath: join(project, 'ancien.bib') })
    );

    expect(response, response.error).toMatchObject({ success: true });
    expect(reserves.issues).toContainEqual(missing(project));
    expect(reserves.unresolvedCitations).toEqual(['dupont2020']);
    expect(docxText(join(project, 'article.docx'))).not.toContain(ANCIEN_TITRE);
  });

  it('projet B ouvert pendant l’export de A : la bibliographie reste celle de A', async () => {
    const project = makeProject('article');
    h.current = makeProject('article', { title: TITRE_B });

    const { response } = await call('word-export:export', windowOptions(project, 'article.docx'));

    expect(response, response.error).toMatchObject({ success: true });
    const text = docxText(join(project, 'article.docx'));
    expect(text).toContain(TITRE);
    expect(text).not.toContain(TITRE_B);
  });
});

/**
 * Sans pandoc, le générateur interne. Son moteur prend les références en mémoire, mais n'applique
 * le style du projet qu'avec une bibliographie, comme pandoc `--csl` : `[[MARQUEUR` dit que l'export
 * a vu le `.bib` du projet. Ces cas tournent aussi en CI.
 */
describe('word-export:export sans pandoc : la bibliographie du projet, relue à l’export', () => {
  beforeEach(async () => {
    vi.spyOn(wordExportService as unknown as { checkPandoc: () => Promise<boolean> }, 'checkPandoc').mockResolvedValue(
      false
    );
    await bibliographyService.parseContent(reference(TITRE));
  });

  function nativeText(docx: string): string {
    const zip = new PizZip(readFileSync(docx));
    return (zip.file('word/document.xml')?.asText() ?? '').replace(/<[^>]+>/g, '');
  }

  it('rattachée pendant la séance, inconnue du renderer : le style du projet rend la citation (témoin, BT1-4)', async () => {
    const project = makeProject('article');
    writeFileSync(join(project, 'marqueur.csl'), MARQUEUR_CSL);

    const { response, reserves } = await call(
      'word-export:export',
      windowOptions(project, 'article.docx', { cslPath: join(project, 'marqueur.csl') })
    );

    expect(response, response.error).toMatchObject({ success: true });
    expect(reserves).toMatchObject({ issues: [], unresolvedCitations: [] });
    const text = nativeText(join(project, 'article.docx'));
    expect(text).toContain('[[MARQUEUR Dupont]]');
    expect(text).not.toContain('@dupont2020');
  });

  it('.bib nommé par project.json et absent : l’ancien ne le remplace pas, et la fenêtre le dit', async () => {
    const project = makeProject('article', { title: null });
    writeFileSync(join(project, 'marqueur.csl'), MARQUEUR_CSL);

    const { response, reserves } = await call(
      'word-export:export',
      windowOptions(project, 'article.docx', {
        bibliographyPath: join(project, 'ancien.bib'),
        cslPath: join(project, 'marqueur.csl'),
      })
    );

    expect(response, response.error).toMatchObject({ success: true });
    expect(reserves.issues).toContainEqual(missing(project));
    expect(reserves.unresolvedCitations).toEqual(['dupont2020']);
    // Sans bibliographie, le style du projet ne s'applique pas : la clé reste, nommée ci-dessus.
    const text = nativeText(join(project, 'article.docx'));
    expect(text).not.toContain('MARQUEUR');
    expect(text).toContain('[@dupont2020]');
  });

  /**
   * La réserve dit que des citations restent brutes faute du `.bib` : sans citation, ou toutes
   * rendues par le style intégré (références en mémoire), l'export sortirait identique avec lui, et
   * la fenêtre ne doit pas rester ouverte pour inviter à le relancer (revue de L04-8).
   */
  it('.bib nommé et absent, document sans citation : rien à dire', async () => {
    const project = makeProject('article', { title: null });

    const { response, reserves } = await call(
      'word-export:export',
      windowOptions(project, 'article.docx', { content: 'Texte sans citation.\n' })
    );

    expect(response, response.error).toMatchObject({ success: true });
    expect(reserves).toMatchObject({ issues: [], unresolvedCitations: [] });
  });

  it('.bib nommé et absent, style intégré et références en mémoire : la citation est rendue, rien à dire', async () => {
    const project = makeProject('article', { title: null });

    const { response, reserves } = await call(
      'word-export:export',
      windowOptions(project, 'article.docx', {
        citation: { useEngine: true, style: 'chicago-note-bibliography', locale: 'fr-FR' },
      })
    );

    expect(response, response.error).toMatchObject({ success: true });
    expect(reserves).toMatchObject({ issues: [], unresolvedCitations: [] });
    const text = nativeText(join(project, 'article.docx'));
    expect(text).not.toContain('@dupont2020');
    expect(text.toLowerCase()).toContain(TITRE);
  });

  it('.bib nommé et absent, style intégré, une clé absente de la mémoire : le fichier et la clé sont nommés', async () => {
    const project = makeProject('article', { title: null });

    const { response, reserves } = await call(
      'word-export:export',
      windowOptions(project, 'article.docx', {
        content: 'Dupont [@dupont2020] et Martin [@martin2019] le disent.\n',
        citation: { useEngine: true, style: 'chicago-note-bibliography', locale: 'fr-FR' },
      })
    );

    expect(response, response.error).toMatchObject({ success: true });
    expect(reserves.issues).toEqual([missing(project)]);
    expect(reserves.unresolvedCitations).toEqual(['martin2019']);
  });

  it('.bib nommé et absent, citation narrative seule (@clé nue) : le fichier est nommé (témoin)', async () => {
    const project = makeProject('article', { title: null });

    const { response, reserves } = await call(
      'word-export:export',
      windowOptions(project, 'article.docx', { content: 'Comme le montre @dupont2020, l’archive se lit.\n' })
    );

    // Avec le `.bib`, pandoc l'aurait mise en forme ; sans lui, elle reste telle quelle. Rien ne la
    // distingue d'un pseudonyme : une réserve de trop plutôt qu'un silence, comme `citationsLeftRaw`.
    expect(response, response.error).toMatchObject({ success: true });
    expect(reserves.issues).toEqual([missing(project)]);
    expect(reserves.unresolvedCitations).toEqual([]);
    expect(nativeText(join(project, 'article.docx'))).toContain('@dupont2020');
  });
});
