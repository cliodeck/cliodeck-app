import { spawn } from 'child_process';
import { writeFile, mkdir, readFile, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { extendedToolPath, toolFinderCommand } from '../../../backend/core/tools/external-tools.js';
import { processMarkdownCitations } from './citation-pipeline.js';
import { bibliographyService } from './bibliography-service.js';
import type { BookSettings, Chapter } from '../../../backend/types/book.js';
import { assembleManuscript } from './manuscript-assembler.js';
import { isInsideAsync } from '../../../backend/core/vector-store/file-identity.js';
import {
  pathExists,
  withExportTimeLimit,
  type ExportClock,
  type ExportLimits,
  type ExportResult,
} from './export-time-limit.js';
import { stripLeadingHeading } from '../../editor/outline.js';
import { resolveProjectCsl } from './export-project-files.js';
import {
  type BeamerConfig,
  buildBeamerCustomizations,
  buildPandocArgs,
  resolveBibliographyMode,
  resolveBookSettings,
} from './pandoc-args.js';

// MARK: - Types

export interface ExportOptions {
  projectPath: string;
  projectType: 'article' | 'book' | 'presentation';
  content: string;
  /**
   * Réglages d'ouvrage (projets `book`) : numérotation des titres et style
   * de notes. Le contenu, lui, arrive déjà assemblé par
   * `manuscript-assembler` — c'est lui qui place les bascules de matière et
   * les vidages de notes de fin.
   */
  bookSettings?: BookSettings;
  /**
   * Manuscrit multi-fichiers (projets `book`). Quand il est fourni, le
   * contenu exporté est ASSEMBLÉ ici — `content` est ignoré. L'assemblage
   * vit côté main parce que c'est là que sont les fichiers, et qu'une
   * bibliographie par chapitre exige d'invoquer pandoc par pièce.
   */
  manuscript?: {
    chapters: Chapter[];
    liveOverrides?: Record<string, string>;
    scope?: 'book' | { chapterId: string };
  };
  outputPath?: string;
  bibliographyPath?: string;
  cslPath?: string; // Path to CSL file for citation styling
  /**
   * Citation rendering options. When provided, the in-process
   * CitationEngine pipeline pre-processes `[@key]` markers into Pandoc
   * footnotes + appends a bibliography, bypassing pandoc's --citeproc.
   */
  citation?: {
    useEngine?: boolean;
    style?: string;
    locale?: string;
  };
  metadata?: {
    title?: string;
    author?: string;
    date?: string;
    abstract?: string;
  };
  beamerConfig?: BeamerConfig;
}

interface PandocProgress {
  stage: 'preparing' | 'converting' | 'compiling' | 'complete';
  message: string;
  progress: number;
}

// MARK: - Templates

/**
 * Get system fonts based on the current platform
 * Each OS has different default fonts available
 */
const getSystemFonts = (): { mainFont: string; sansFont: string; monoFont: string } => {
  const platform = process.platform;

  switch (platform) {
    case 'darwin': // macOS
      return {
        mainFont: 'Times New Roman',
        sansFont: 'Helvetica Neue',
        monoFont: 'Menlo',
      };
    case 'win32': // Windows
      return {
        mainFont: 'Times New Roman',
        sansFont: 'Arial',
        monoFont: 'Consolas',
      };
    case 'linux': // Linux
    default:
      // DejaVu fonts are commonly available on Linux distributions
      // They have excellent Unicode coverage including French accents
      return {
        mainFont: 'DejaVu Serif',
        sansFont: 'DejaVu Sans',
        monoFont: 'DejaVu Sans Mono',
      };
  }
};

/**
 * Ce que pandoc écrit et que seul SON gabarit par défaut définit (J19). Sans ce préambule, tout
 * tableau échouait sur « Environment longtable undefined » (puis « No counter 'none' defined »),
 * toute image sur « Undefined control sequence \pandocbounded », tout texte barré sur `\st`,
 * toute liste de tâches sur `\square` ; le souligné, les formules alignées et le code dans une
 * note de même.
 *
 * Recopié de pandoc 3.13 : `amsmath,amssymb` du gabarit (`pandoc --print-default-template
 * latex`), `\VerbatimFootnotes` du partiel `after-header-includes.latex`, le reste du partiel
 * `common.latex` (`pandoc --print-default-data-file templates/common.latex`), avec ses
 * conditions — un document sans tableau ne charge ni longtable ni caption. N'en restent que les
 * branches de xelatex hors beamer : xelatex est le seul moteur de l'export, et les présentations
 * compilent avec le gabarit beamer de pandoc lui-même.
 *
 * Inclure le partiel (`$common.latex()$`) au lieu de le recopier ne tient pas : il redéfinit les
 * macros de coloration et `CSLReferences` de ces gabarits (« Command \VerbBar already defined »),
 * met les paragraphes sans alinéa (parskip) et n'existe qu'à partir de pandoc 3.5. Une version
 * suivante de pandoc peut écrire une macro de plus : `pdf-export-latex.test.ts` compile chaque
 * construction avec le pandoc installé.
 */
const PANDOC_OUTPUT_PREAMBLE = `% Ce que pandoc ecrit et que seul son gabarit par defaut definit : recopie
% de pandoc 3.13 (default.latex, partiels common.latex et after-header-includes.latex),
% branches xelatex hors beamer.
\\usepackage{amsmath,amssymb}
$if(verbatim-in-note)$
\\usepackage{fancyvrb}
\\VerbatimFootnotes % allow verbatim text in footnotes
$endif$
$if(tables)$
\\usepackage{longtable,booktabs,array}
\\usepackage{caption}
\\captionsetup[table]{skip=6pt}
\\newcounter{none} % for unnumbered tables
$if(multirow)$
\\usepackage{multirow}
$endif$
\\usepackage{calc} % for calculating minipage widths
% Correct order of tables after \\paragraph or \\subparagraph
\\usepackage{etoolbox}
\\makeatletter
\\patchcmd\\longtable{\\par}{\\if@noskipsec\\mbox{}\\fi\\par}{}{}
\\makeatother
$endif$
$if(graphics)$
\\usepackage{graphicx}
\\makeatletter
\\newsavebox\\pandoc@box
\\newcommand*\\pandocbounded[1]{% scales image to fit in text height/width
  \\sbox\\pandoc@box{#1}%
  \\Gscale@div\\@tempa{\\textheight}{\\dimexpr\\ht\\pandoc@box+\\dp\\pandoc@box\\relax}%
  \\Gscale@div\\@tempb{\\linewidth}{\\wd\\pandoc@box}%
  \\ifdim\\@tempb\\p@<\\@tempa\\p@\\let\\@tempa\\@tempb\\fi% select the smaller of both
  \\ifdim\\@tempa\\p@<\\p@\\scalebox{\\@tempa}{\\usebox\\pandoc@box}%
  \\else\\usebox{\\pandoc@box}%
  \\fi%
}
% Set default figure placement to htbp
\\def\\fps@figure{htbp}
\\makeatother
$endif$
$if(svg)$
\\usepackage{svg}
$endif$
$if(strikeout)$
\\usepackage{soul}
$endif$`;

/**
 * Citations liées (J19). Avec `link-citations: true` dans l'en-tête YAML du document, pandoc
 * écrit `\citeproc{ref-cle}{texte}`, que seul le bloc `csl-refs` de `common.latex` définit :
 * « Undefined control sequence \citeproc » sinon. Par `\cite`, le texte devient un lien vers le
 * `\bibitem[\citeproctext]{ref-cle}` que pandoc écrit toujours dans `CSLReferences`.
 *
 * Recopié de pandoc 3.13, sans son `\citeproctext` : celui des gabarits, robuste, reste en place
 * (`\citeproc` le redéfinit dans un groupe). Sans `link-citations`, pandoc n'écrit pas `\cite`, et
 * `CSLReferences` efface déjà les étiquettes de `\bibitem` : le rendu ne change pas (mesuré :
 * pages identiques à l'octet près, article et livre).
 *
 * Une seule différence avec pandoc : une clé sans notice (`@inconnu2020`) garde le texte que
 * pandoc écrit pour elle (« inconnu2020? »), au lieu du « ? » de `\cite` (« ( ?) », avec le
 * gabarit de pandoc aussi) : l'historien voit quelle citation manque. Une clé connue n'a son
 * `b@ref-cle` qu'à partir de la deuxième passe de xelatex, que pandoc relance tant que LaTeX le
 * demande (« Label(s) may have changed ») : les citations connues restent des liens (mesuré :
 * mêmes liens, pages identiques à l'octet près).
 */
const PANDOC_CITEPROC_LINKS = `% Citations liees (link-citations) : recopie de pandoc 3.13 (common.latex, bloc csl-refs),
% sauf pour une cle sans notice : pandoc en ecrit le nom (inconnu2020?), que \\cite
% remplacerait par un simple point d'interrogation.
\\makeatletter
\\NewDocumentCommand\\citeproc{mm}{%
  \\@ifundefined{b@#1}{#2}{\\begingroup\\def\\citeproctext{#2}\\cite{#1}\\endgroup}}
 % allow citations to break across lines
 \\let\\@cite@ofmt\\@firstofone
 % avoid brackets around text for \\cite:
 \\def\\@biblabel#1{}
 \\def\\@cite#1#2{{#1\\if@tempswa , #2\\fi}}
\\makeatother`;

const getLatexTemplate = (projectType: string): string => {
  // Get platform-appropriate system fonts
  const { mainFont, sansFont, monoFont } = getSystemFonts();

  switch (projectType) {
    case 'article':
      return `\\documentclass[12pt,a4paper]{article}
\\usepackage{fontspec}
\\usepackage{polyglossia}
\\setmainlanguage{french}
\\usepackage{geometry}
\\geometry{margin=2.5cm}
\\usepackage{hyperref}
\\usepackage{graphicx}
\\usepackage{fancyhdr}

% Disable section numbering
\\setcounter{secnumdepth}{0}

% Fonts - platform-specific system fonts
\\setmainfont{${mainFont}}[Ligatures=TeX]
\\setsansfont{${sansFont}}[Ligatures=TeX]
\\setmonofont{${monoFont}}[Scale=0.9]

% Pandoc compatibility - define commands that Pandoc may generate
% These are not defined in standard LaTeX classes but used by Pandoc
\\providecommand{\\tightlist}{}           % Compact lists
\\providecommand{\\textquotesingle}{'}     % Straight single quote
\\providecommand{\\textendash}{-}        % En dash
\\providecommand{\\textemdash}{--}       % Em dash

% Coloration syntaxique : pandoc emet \\begin{Shaded} des qu'un bloc de code
% est colore, mais les macros correspondantes ne vivent que dans SON template
% par defaut. Sans cette variable, tout document contenant un bloc de code
% echoue a la compilation (« Environment Shaded undefined »).
$highlighting-macros$

${PANDOC_OUTPUT_PREAMBLE}

% CSLReferences environment and commands for pandoc citeproc
\\newlength{\\cslhangindent}
\\setlength{\\cslhangindent}{1.5em}
\\newlength{\\csllabelwidth}
\\setlength{\\csllabelwidth}{0em}
\\newenvironment{CSLReferences}[2] % #1 hanging-ident, #2 entry spacing
 {\\begin{list}{}{%
  \\setlength{\\itemindent}{-1.5em}
  \\setlength{\\leftmargin}{1.5em}
  \\setlength{\\itemsep}{#2\\baselineskip}
  \\setlength{\\parsep}{0pt}
  \\setlength{\\labelsep}{0pt}
  \\setlength{\\labelwidth}{0pt}
  \\renewcommand{\\makelabel}[1]{}}}
 {\\end{list}}
\\newcommand{\\CSLBlock}[1]{#1\\hfill\\break}
\\newcommand{\\CSLLeftMargin}[1]{}
\\newcommand{\\CSLRightInline}[1]{#1\\break}
\\newcommand{\\CSLIndent}[1]{\\hspace{\\cslhangindent}#1}
\\DeclareRobustCommand{\\citeproctext}{}
\\DeclareRobustCommand{\\citeprocdate}{}
\\DeclareRobustCommand{\\citeprocvolume}{}
\\DeclareRobustCommand{\\citeprocissue}{}
\\DeclareRobustCommand{\\citeprocpages}{}
${PANDOC_CITEPROC_LINKS}

% Header/Footer
\\pagestyle{fancy}
\\fancyhf{}
\\rhead{\\thepage}
\\lhead{\\textit{$title$}}

\\title{$title$}
\\author{$author$}
\\date{$date$}

\\begin{document}

\\maketitle

\\begin{abstract}
$if(abstract)$
$abstract$
$else$
Résumé à compléter.
$endif$
\\end{abstract}

$body$

\\end{document}`;

    case 'book':
      return `\\documentclass[12pt,a4paper]{book}
\\usepackage{fontspec}
\\usepackage{polyglossia}
\\setmainlanguage{french}
\\usepackage{geometry}
\\geometry{margin=2.5cm}
\\usepackage{hyperref}
\\usepackage{graphicx}
\\usepackage{fancyhdr}

% Numérotation pilotée par les réglages d'ouvrage (plan chapitres, §5
% arbitrage 2). En classe book : -1 = rien, 0 = chapitres, 1 = sections.
\\setcounter{secnumdepth}{$if(secnumdepth)$$secnumdepth$$else$0$endif$}

% La classe book ne definit PAS d'environnement abstract (contrairement a
% article) : sans cette definition, un livre pourvu d'un abstract.md echoue
% a la compilation. Le resume tient lieu de quatrieme de couverture
% (arbitrage 8).
\\newenvironment{abstract}%
  {\\small\\begin{center}\\bfseries R\\'esum\\'e\\end{center}\\begin{quotation}}%
  {\\end{quotation}}

% Notes de fin (reglage noteStyle) : le paquet endnotes accumule les notes
% jusqu'au prochain \\theendnotes, que l'assembleur place apres chaque
% chapitre ou en fin d'ouvrage.
% Une note dans un tableau ou dans une legende, pandoc l'ecrit en deux temps :
% \\footnotemark{} dans la cellule, \\footnotetext{...} apres, avec des
% \\addtocounter{footnote}{-1} entre plusieurs. Les trois passent aux notes de
% fin, et le compteur footnote devient celui des notes de fin : sans cela, ces
% notes sortaient en bas de page, numerotees a part (J19). La classe book
% remet footnote a zero a chaque chapitre : plus maintenant, puisque c'est le
% compteur des notes de fin, que seul l'assembleur remet a zero (per-chapter).
$if(endnotes)$
\\usepackage{endnotes}
\\let\\footnote\\endnote
\\let\\footnotemark\\endnotemark
\\let\\footnotetext\\endnotetext
\\makeatletter
\\let\\c@footnote\\c@endnote
\\makeatother
\\counterwithout{footnote}{chapter}
\\renewcommand{\\notesname}{Notes}
$endif$

% Fonts - platform-specific system fonts
\\setmainfont{${mainFont}}[Ligatures=TeX]
\\setsansfont{${sansFont}}[Ligatures=TeX]
\\setmonofont{${monoFont}}[Scale=0.9]

% Pandoc compatibility - define commands that Pandoc may generate
% These are not defined in standard LaTeX classes but used by Pandoc
\\providecommand{\\tightlist}{}           % Compact lists
\\providecommand{\\textquotesingle}{'}     % Straight single quote
\\providecommand{\\textendash}{-}        % En dash
\\providecommand{\\textemdash}{--}       % Em dash

% Coloration syntaxique : pandoc emet \\begin{Shaded} des qu'un bloc de code
% est colore, mais les macros correspondantes ne vivent que dans SON template
% par defaut. Sans cette variable, tout document contenant un bloc de code
% echoue a la compilation (« Environment Shaded undefined »).
$highlighting-macros$

${PANDOC_OUTPUT_PREAMBLE}

% CSLReferences environment and commands for pandoc citeproc
\\newlength{\\cslhangindent}
\\setlength{\\cslhangindent}{1.5em}
\\newlength{\\csllabelwidth}
\\setlength{\\csllabelwidth}{0em}
\\newenvironment{CSLReferences}[2] % #1 hanging-ident, #2 entry spacing
 {\\begin{list}{}{%
  \\setlength{\\itemindent}{-1.5em}
  \\setlength{\\leftmargin}{1.5em}
  \\setlength{\\itemsep}{#2\\baselineskip}
  \\setlength{\\parsep}{0pt}
  \\setlength{\\labelsep}{0pt}
  \\setlength{\\labelwidth}{0pt}
  \\renewcommand{\\makelabel}[1]{}}}
 {\\end{list}}
\\newcommand{\\CSLBlock}[1]{#1\\hfill\\break}
\\newcommand{\\CSLLeftMargin}[1]{}
\\newcommand{\\CSLRightInline}[1]{#1\\break}
\\newcommand{\\CSLIndent}[1]{\\hspace{\\cslhangindent}#1}
\\DeclareRobustCommand{\\citeproctext}{}
\\DeclareRobustCommand{\\citeprocdate}{}
\\DeclareRobustCommand{\\citeprocvolume}{}
\\DeclareRobustCommand{\\citeprocissue}{}
\\DeclareRobustCommand{\\citeprocpages}{}
${PANDOC_CITEPROC_LINKS}

% Header/Footer
\\pagestyle{fancy}
\\fancyhf{}
\\fancyhead[LE,RO]{\\thepage}
\\fancyhead[LO]{\\textit{\\nouppercase{\\rightmark}}}
\\fancyhead[RE]{\\textit{\\nouppercase{\\leftmark}}}

\\title{$title$}
\\author{$author$}
\\date{$date$}

\\begin{document}

\\frontmatter
\\maketitle
$if(abstract)$
\\begin{abstract}
$abstract$
\\end{abstract}
$endif$
\\tableofcontents

$body$

\\end{document}`;

    case 'presentation':
      return `\\documentclass[11pt,aspectratio=169,xcolor={dvipsnames}]{beamer}
\\usepackage{fontspec}
\\usepackage{polyglossia}
\\setmainlanguage{french}

% Fonts - platform-specific system fonts
\\setmainfont{${mainFont}}
\\setsansfont{${sansFont}}
\\setmonofont{${monoFont}}

\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{listings}
\\usepackage{longtable}
\\usepackage{booktabs}
\\usepackage{caption}

% Pandoc compatibility - define commands that Pandoc may generate
% These are not defined in standard LaTeX classes but used by Pandoc
% Must be defined BEFORE any Beamer configuration
\\providecommand{\\tightlist}{}           % Compact lists
\\providecommand{\\textquotesingle}{'}     % Straight single quote
\\providecommand{\\textendash}{-}        % En dash
\\providecommand{\\textemdash}{--}       % Em dash

% Coloration syntaxique : pandoc emet \\begin{Shaded} des qu'un bloc de code
% est colore, mais les macros correspondantes ne vivent que dans SON template
% par defaut. Sans cette variable, tout document contenant un bloc de code
% echoue a la compilation (« Environment Shaded undefined »).
$highlighting-macros$

% ============================================================================
% Elegant Slides Theme - Adapted for Pandoc
% Based on https://github.com/lsprung/elegant-slides
% License: CC BY 4.0
% ============================================================================

% Color definitions (Lecture theme)
\\definecolor{primary}{HTML}{08457E}
\\definecolor{secondary}{HTML}{B8860B}
\\definecolor{tertiary}{HTML}{B22222}
\\definecolor{accent}{HTML}{F5F5F5}

% Beamer color theme
\\setbeamercolor{frametitle}{fg=primary}
\\setbeamercolor{framesubtitle}{fg=secondary}
\\setbeamercolor{title}{fg=primary}
\\setbeamercolor{subtitle}{fg=secondary}
\\setbeamercolor{author}{fg=black}
\\setbeamercolor{date}{fg=black}
\\setbeamercolor{institute}{fg=black}
\\setbeamercolor{section in toc}{fg=primary}
\\setbeamercolor{subsection in toc}{fg=secondary}
\\setbeamercolor{item}{fg=primary}
\\setbeamercolor{subitem}{fg=secondary}
\\setbeamercolor{subsubitem}{fg=tertiary}
\\setbeamercolor{block title}{fg=white,bg=primary}
\\setbeamercolor{block body}{fg=black,bg=accent}
\\setbeamercolor{block title alerted}{fg=white,bg=tertiary}
\\setbeamercolor{block body alerted}{fg=black,bg=accent}
\\setbeamercolor{block title example}{fg=white,bg=secondary}
\\setbeamercolor{block body example}{fg=black,bg=accent}

% Font settings
\\setbeamerfont{frametitle}{size=\\Large,series=\\bfseries}
\\setbeamerfont{framesubtitle}{size=\\normalsize,series=\\mdseries}
\\setbeamerfont{title}{size=\\LARGE,series=\\bfseries}
\\setbeamerfont{subtitle}{size=\\large,series=\\mdseries}
\\setbeamerfont{author}{size=\\normalsize}
\\setbeamerfont{date}{size=\\small}
\\setbeamerfont{institute}{size=\\small}

% Disable navigation symbols
\\setbeamertemplate{navigation symbols}{}

% Customize footline (frame number)
\\setbeamertemplate{footline}{
  \\hfill\\insertframenumber\\hspace{0.5cm}\\vspace{0.3cm}
}

% Customize frame title
\\setbeamertemplate{frametitle}{
  \\vspace{0.5cm}
  \\textbf{\\insertframetitle}
  \\ifx\\insertframesubtitle\\@empty
  \\else
    \\\\{\\color{secondary}\\small\\insertframesubtitle}
  \\fi
  \\vspace{0.2cm}
}

% Customize itemize
\\setbeamertemplate{itemize items}[circle]
\\setbeamertemplate{itemize subitem}[triangle]
\\setbeamertemplate{itemize subsubitem}[square]

% Customize title page
\\setbeamertemplate{title page}{
  \\vfill
  \\begin{centering}
    {\\usebeamerfont{title}\\usebeamercolor[fg]{title}\\inserttitle\\par}
    \\vspace{0.5cm}
    {\\usebeamerfont{subtitle}\\usebeamercolor[fg]{subtitle}\\insertsubtitle\\par}
    \\vspace{1.5cm}
    {\\usebeamerfont{author}\\usebeamercolor[fg]{author}\\insertauthor\\par}
    \\vspace{0.3cm}
    {\\usebeamerfont{institute}\\usebeamercolor[fg]{institute}\\insertinstitute\\par}
    \\vspace{0.3cm}
    {\\usebeamerfont{date}\\usebeamercolor[fg]{date}\\insertdate\\par}
  \\end{centering}
  \\vfill
}

% Code listings style (elegant)
\\lstset{
  basicstyle=\\ttfamily\\small,
  breaklines=true,
  frame=leftline,
  framerule=2pt,
  rulecolor=\\color{primary},
  backgroundcolor=\\color{accent},
  xleftmargin=10pt,
  framexleftmargin=8pt
}

% Hyperref setup
\\hypersetup{
  colorlinks=true,
  linkcolor=primary,
  urlcolor=secondary,
  citecolor=tertiary
}

% Title page info
\\title{$title$}
\\author{$author$}
\\date{$date$}
$if(institute)$\\institute{$institute$}$endif$
$if(subtitle)$\\subtitle{$subtitle$}$endif$

\\begin{document}

% Title page
{
\\setbeamertemplate{footline}{}
\\begin{frame}
  \\titlepage
\\end{frame}
}
\\addtocounter{framenumber}{-1}

% Abstract
$if(abstract)$
\\begin{frame}{Résumé}
$abstract$
\\end{frame}
$endif$

% Content
$body$

\\end{document}`;

    default:
      // Default to article template
      return getLatexTemplate('article');
  }
};

// MARK: - Service

export class PDFExportService {
  /**
   * PATH des outils d'export : voir `backend/core/tools/external-tools.ts` (emplacements ajoutés
   * hors Windows, où le PATH part tel quel).
   */
  private getExtendedPath(): string {
    return extendedToolPath(process.env.PATH || '');
  }

  /**
   * Check if pandoc and xelatex are available
   */
  async checkDependencies(): Promise<{ pandoc: boolean; xelatex: boolean }> {
    const extendedPath = this.getExtendedPath();

    const checkCommand = async (command: string): Promise<boolean> => {
      return new Promise((resolve) => {
        const proc = spawn(toolFinderCommand(), [command], {
          env: { ...process.env, PATH: extendedPath }
        });
        proc.on('error', () => resolve(false));
        proc.on('close', (code) => resolve(code === 0));
      });
    };

    const [pandoc, xelatex] = await Promise.all([
      checkCommand('pandoc'),
      checkCommand('xelatex'),
    ]);

    return { pandoc, xelatex };
  }

  /**
   * Résout les citations d'UN chapitre par un passage de citeproc isolé
   * (réglage `bibliography: 'per-chapter'`).
   *
   * Citeproc ne produit qu'une bibliographie par document : l'obtenir par
   * chapitre suppose de l'exécuter pièce par pièce, puis de recomposer. Le
   * round-trip markdown est sémantiquement sûr (vérifié : listes, emphase,
   * blocs de code et guillemets préservés ; les tables passent en forme
   * simple, sans perte). Pandoc évite lui-même les collisions avec les
   * notes de l'auteur ; l'isolation entre chapitres reste assurée par le
   * préfixage qui suit dans l'assembleur.
   *
   * Le repli ci-dessous ne vaut que pour un échec isolé. Après un dépassement,
   * l'horloge refuse tout nouvel outil et l'export rend `export_timed_out` :
   * jamais un PDF aux `[@clef]` non résolues, sans rien dire.
   */
  private async resolveCitationsInChapter(
    content: string,
    opts: { bibliographyPath: string; cslPath?: string; tempDir: string; clock: ExportClock }
  ): Promise<string> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inPath = join(opts.tempDir, `chapter-${stamp}.md`);
    await writeFile(inPath, content, 'utf-8');

    const args = [
      inPath,
      '-t', 'markdown',
      '--wrap=preserve',
      '--citeproc',
      '--bibliography', opts.bibliographyPath,
    ];
    if (opts.cslPath && (await pathExists(opts.cslPath))) {
      args.push('--csl', opts.cslPath);
    }

    const extendedPath = this.getExtendedPath();
    return new Promise<string>((resolve) => {
      const proc = opts.clock.spawn('pandoc', args, {
        cwd: opts.tempDir,
        env: { ...process.env, PATH: extendedPath },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout);
        } else {
          // Échec isolé : le chapitre part avec ses `[@clef]` non résolues
          // plutôt que de faire échouer tout l'export.
          console.warn('⚠️ citeproc par chapitre a échoué, chapitre laissé tel quel:', stderr.slice(0, 200));
          resolve(content);
        }
      });
      proc.on('error', (err) => {
        console.warn('⚠️ citeproc par chapitre indisponible:', err.message);
        resolve(content);
      });
    });
  }

  /**
   * Export markdown to PDF using pandoc and xelatex
   */
  async exportToPDF(
    options: ExportOptions,
    onProgress?: (progress: PandocProgress) => void,
    limits?: ExportLimits
  ): Promise<ExportResult> {
    return withExportTimeLimit(limits, (clock) => this.runExport(options, onProgress, clock));
  }

  private async runExport(
    options: ExportOptions,
    onProgress: ((progress: PandocProgress) => void) | undefined,
    clock: ExportClock
  ): Promise<ExportResult> {
    // Déclaré hors du `try` pour que le `finally` puisse nettoyer même en
    // cas d'échec : un export raté (LaTeX manquant, caractère exotique)
    // laissait sinon le manuscrit complet en clair dans le répertoire
    // temporaire, lisible par tout compte de la machine.
    let tempDir: string | null = null;
    try {
      // Check dependencies
      onProgress?.({ stage: 'preparing', message: 'Vérification des dépendances...', progress: 10 });
      const deps = await this.checkDependencies();

      if (!deps.pandoc) {
        throw new Error('Pandoc n\'est pas installé. Installez-le avec: brew install pandoc');
      }

      if (!deps.xelatex) {
        throw new Error('XeLaTeX n\'est pas installé. Installez-le avec: brew install --cask mactex');
      }

      // Create temporary directory for build
      tempDir = join(tmpdir(), `cliodeck-export-${Date.now()}`);
      await mkdir(tempDir, { recursive: true });

      onProgress?.({ stage: 'preparing', message: 'Préparation des fichiers...', progress: 20 });

      // Style du projet : résolu contre le projet (un chemin relatif était
      // cherché dans le dossier courant), et son absence se dit au lieu
      // d'écarter `--csl` en silence. Case « style intégré » cochée, il n'est
      // pas demandé.
      const projectCsl = await resolveProjectCsl(options.projectPath, options.cslPath);
      options = { ...options, cslPath: projectCsl.path };
      const missingCsl = options.citation?.useEngine ? undefined : projectCsl.missing;
      if (missingCsl) console.warn('⚠️ pdf-export: style CSL du projet introuvable:', missingCsl);

      // Try to load abstract from abstract.md if no abstract in metadata
      let abstract = options.metadata?.abstract;
      if (!abstract && (options.projectType === 'article' || options.projectType === 'book')) {
        // projectPath is the folder path for the project
        const abstractPath = join(options.projectPath, 'abstract.md');
        console.log('🔍 Looking for abstract at:', abstractPath);
        // Un lien qui sort du projet n'est pas lu : ce fichier s'imprimerait dans l'export.
        if ((await pathExists(abstractPath)) && (await isInsideAsync(options.projectPath, abstractPath))) {
          const abstractContent = await readFile(abstractPath, 'utf-8');
          // Retire le titre de tête quel qu'il soit (« # Résumé », mais
          // aussi « # Abstract » ou « # Quatrième de couverture ») : passé
          // tel quel en métadonnée, il s'imprimerait échappé en `\#`.
          abstract = stripLeadingHeading(abstractContent);
          console.log('📄 Abstract loaded from file:', abstractPath);
          console.log('📄 Abstract content preview:', abstract.substring(0, 200));
        } else {
          console.log('⚠️ Abstract file not found at:', abstractPath);
        }
      }

      // Write markdown content. L'éditeur CM6 n'échappe jamais le
      // markdown : le hack unescapeCitations de l'ère Milkdown a été
      // retiré en Phase 5 (les \[@clef\] résiduels de vieux documents se
      // nettoient à la main, cf. CHANGELOG).
      const mdPath = join(tempDir, 'input.md');
      let cleanedContent = options.content;

      // Assemblage du manuscrit (projets « livre »). La bibliographie par
      // chapitre passe par le hook `transformChapter` : citeproc tourne
      // pièce par pièce, AVANT le préfixage des notes — ses propres notes
      // générées doivent être isolées comme celles de l'auteur.
      if (options.manuscript) {
        const settings = resolveBookSettings(options.bookSettings);

        const bibMode = resolveBibliographyMode({
          settings,
          bibliographyAvailable:
            !!options.bibliographyPath && (await pathExists(options.bibliographyPath)),
          useEngine: !!options.citation?.useEngine,
        });
        const perChapterBib = bibMode.perChapter;
        if (bibMode.warning) console.warn('⚠️ ' + bibMode.warning);

        const assembled = await assembleManuscript({
          projectPath: options.projectPath,
          chapters: options.manuscript.chapters,
          settings,
          liveOverrides: options.manuscript.liveOverrides,
          scope: options.manuscript.scope,
          transformChapter: perChapterBib
            ? (content) =>
                this.resolveCitationsInChapter(content, {
                  bibliographyPath: options.bibliographyPath!,
                  cslPath: options.cslPath,
                  tempDir,
                  clock,
                })
            : undefined,
        });

        for (const warning of assembled.warnings) {
          console.warn('⚠️ Assemblage :', warning);
        }
        console.log(
          `📚 Manuscrit assemblé : ${assembled.chapterCount} pièce(s), bibliographie ${settings.bibliography}`
        );
        cleanedContent = assembled.markdown;

        // Citeproc a déjà tourné pièce par pièce : la passe globale ne doit
        // pas re-résoudre (elle ne trouverait plus de `[@clef]`, mais elle
        // ajouterait une bibliographie vide en fin d'ouvrage).
        if (perChapterBib) {
          options = { ...options, bibliographyPath: undefined };
        }
      }

      // In-process CitationEngine pipeline (opt-in). Runs BEFORE pandoc —
      // resolves [@key] markers into Pandoc [^N] footnotes and appends a
      // bibliography section, so pandoc treats them as plain footnotes and
      // we don't need --citeproc / --bibliography.
      let useEnginePipeline = false;
      if (options.citation?.useEngine) {
        try {
          const style = options.citation.style ?? 'chicago-note-bibliography';
          const locale = options.citation.locale ?? 'fr-FR';
          const processed = await processMarkdownCitations(cleanedContent, {
            style,
            locale,
            resolve: (key) => bibliographyService.getByCitationKey(key),
          });
          if (processed.missingKeys.length > 0) {
            console.warn('⚠️ CitationEngine: unresolved keys:', processed.missingKeys);
          }
          cleanedContent = processed.md;
          if (processed.footnotes.length > 0) {
            const footnoteBlock = processed.footnotes
              .map((fn) => `[^${fn.n}]: ${fn.text}`)
              .join('\n\n');
            cleanedContent += '\n\n' + footnoteBlock + '\n';
          }
          if (processed.bibliography.length > 0) {
            const bibBlock =
              '\n\n# Bibliographie\n\n' +
              processed.bibliography.map((b) => `- ${b}`).join('\n') +
              '\n';
            cleanedContent += bibBlock;
          }
          useEnginePipeline = true;
          console.log(
            `📚 CitationEngine: ${processed.footnotes.length} footnote(s), ${processed.bibliography.length} bib entries`
          );
        } catch (err) {
          console.warn('⚠️ CitationEngine pre-processing failed, falling back to pandoc:', err);
        }
      }

      await writeFile(mdPath, cleanedContent);
      console.log('📝 Markdown content written:', mdPath);
      console.log('📝 Content preview (first 500 chars):', cleanedContent.substring(0, 500));

      // Write template
      const templatePath = join(tempDir, 'template.latex');
      const template = getLatexTemplate(options.projectType);
      await writeFile(templatePath, template);

      // Determine output path
      const outputPath = options.outputPath || join(dirname(options.projectPath), `${options.metadata?.title || 'output'}.pdf`);

      // Copy bibliography if provided
      let bibPath: string | undefined;
      if (options.bibliographyPath && (await pathExists(options.bibliographyPath))) {
        bibPath = join(tempDir, 'bibliography.bib');
        const bibContent = await readFile(options.bibliographyPath, 'utf-8');
        await writeFile(bibPath, bibContent);
        console.log('📚 Bibliography copied:', options.bibliographyPath, '->', bibPath);
        console.log('📚 Bibliography size:', bibContent.length, 'bytes');
      } else {
        console.log('⚠️ No bibliography found at:', options.bibliographyPath);
      }

      // Arguments pandoc — la construction est PURE et testée
      // (`pandoc-args.ts`, item 24 de l'audit). Ne reste ici que ce qui
      // touche au monde : écrire le fichier d'en-têtes beamer et résoudre
      // l'existence du CSL.
      let headerIncludesPath: string | undefined;
      if (options.projectType === 'presentation') {
        const customizations = buildBeamerCustomizations(options.beamerConfig);
        if (customizations.length > 0) {
          headerIncludesPath = join(tempDir, 'beamer-custom.tex');
          await writeFile(headerIncludesPath, customizations.join('\n'));
        }
      }

      const cslAvailable = !!options.cslPath && (await pathExists(options.cslPath));
      const pandocArgs = buildPandocArgs({
        mdPath,
        outputPath,
        templatePath,
        projectType: options.projectType,
        bookSettings: options.bookSettings,
        beamerConfig: options.beamerConfig,
        metadata: options.metadata,
        abstract,
        bibPath,
        useEnginePipeline,
        cslPath: options.cslPath,
        cslAvailable,
        headerIncludesPath,
      });

      if (bibPath && !useEnginePipeline && cslAvailable) {
        console.log('📚 Using CSL style:', options.cslPath);
      }

      // Run pandoc
      onProgress?.({ stage: 'converting', message: 'Conversion en LaTeX...', progress: 40 });

      const extendedPath = this.getExtendedPath();

      await clock.run(new Promise<void>((resolve, reject) => {
        console.log('📄 Running pandoc:', 'pandoc', pandocArgs.join(' '));

        // TMPDIR : pandoc compile dans son propre dossier temporaire, avec la
        // copie LaTeX du manuscrit, et ne le retire pas quand on le tue (mesuré
        // sous macOS ; TMP et TEMP pour Windows, non mesuré). Placé ici, il part
        // avec le nôtre.
        const pandoc = clock.spawn('pandoc', pandocArgs, {
          cwd: tempDir,
          env: { ...process.env, PATH: extendedPath, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir },
        });

        let stderr = '';

        pandoc.stderr.on('data', (data) => {
          stderr += data.toString();
          console.log('📄 Pandoc output:', data.toString());

          // Track progress based on output
          if (data.toString().includes('xelatex')) {
            onProgress?.({ stage: 'compiling', message: 'Compilation PDF en cours...', progress: 60 });
          }
        });

        pandoc.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Pandoc failed with code ${code}:\n${stderr}`));
          }
        });

        pandoc.on('error', (err) => {
          reject(new Error(`Failed to start pandoc: ${err.message}`));
        });
      }));

      onProgress?.({ stage: 'complete', message: 'Export terminé!', progress: 100 });

      console.log('✅ PDF exported successfully:', outputPath);
      return { success: true, outputPath, ...(missingCsl ? { missingCsl } : {}) };
    } catch (error: unknown) {
      console.error('❌ PDF export failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Le manuscrit, sa bibliographie et le .tex intermédiaire vivent ici :
      // ils partent, que l'export ait réussi ou échoué.
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch((err) => {
          console.warn('⚠️ Failed to clean export temp directory:', err);
        });
      }
    }
  }
}

export const pdfExportService = new PDFExportService();
