import { spawn } from 'child_process';
import { writeFile, mkdir, readFile, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { tmpdir } from 'os';

// MARK: - Types

export interface ExportOptions {
  projectPath: string;
  projectType: 'article' | 'book' | 'presentation';
  content: string;
  outputPath?: string;
  bibliographyPath?: string;
  cslPath?: string; // Path to CSL file for citation styling
  metadata?: {
    title?: string;
    author?: string;
    date?: string;
    abstract?: string;
  };
  beamerConfig?: {
    // Theme options
    theme?: string;
    colortheme?: string;
    fonttheme?: string;
    aspectratio?: string;
    navigation?: boolean;
    showNotes?: boolean;

    // Title page options
    institute?: string;
    logo?: string;
    titlegraphic?: string;

    // TOC options
    showToc?: boolean;
    tocBeforeSection?: boolean;

    // Frame numbering
    showFrameNumber?: boolean;
    frameNumberStyle?: 'total' | 'simple' | 'none';

    // Section numbering
    showSectionNumber?: boolean;
    sectionNumberInToc?: boolean;

    // Footer customization
    showAuthorInFooter?: boolean;
    showTitleInFooter?: boolean;
    showDateInFooter?: boolean;

    // Advanced options
    incremental?: boolean;
    overlays?: boolean;
  };
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

% Disable section numbering
\\setcounter{secnumdepth}{0}

% Fonts - platform-specific system fonts
\\setmainfont{${mainFont}}[Ligatures=TeX]
\\setsansfont{${sansFont}}[Ligatures=TeX]
\\setmonofont{${monoFont}}[Scale=0.9]

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
\\tableofcontents

\\mainmatter

$body$

\\backmatter

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

% Pandoc compatibility - define tightlist BEFORE any Beamer configuration
\\providecommand{\\tightlist}{}

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

/**
 * Unescape citation keys that were escaped by Milkdown editor
 * Transforms \[@citation\_key] back to [@citation_key]
 */
const unescapeCitations = (content: string): string => {
  // Pattern to match escaped citations: \[@key\_with\_underscores]
  // This handles the backslash before @ and underscores within citation keys
  return content
    // First, unescape the opening bracket: \[@ -> [@
    .replace(/\\(\[@)/g, '$1')
    // Then, unescape underscores within citation brackets [@...\_...] -> [@..._...]
    .replace(/(\[@[^\]]*)\\_([^\]]*\])/g, (_match, before, after) => {
      // Recursively unescape all underscores in the citation
      let result = before + '_' + after;
      while (result.includes('\\_')) {
        result = result.replace('\\_', '_');
      }
      return result;
    });
};

// MARK: - Service

export class PDFExportService {
  /**
   * Get the extended PATH for macOS that includes Homebrew and MacTeX paths
   * GUI apps on macOS don't inherit the user's shell PATH
   */
  private getExtendedPath(): string {
    const currentPath = process.env.PATH || '';
    const additionalPaths = [
      '/opt/homebrew/bin',           // Homebrew on Apple Silicon
      '/usr/local/bin',              // Homebrew on Intel Mac
      '/Library/TeX/texbin',         // MacTeX
      '/usr/texbin',                 // Older MacTeX location
      '/opt/local/bin',              // MacPorts
    ];

    // Add paths that aren't already in PATH
    const pathsToAdd = additionalPaths.filter(p => !currentPath.includes(p));
    return [...pathsToAdd, currentPath].join(':');
  }

  /**
   * Check if pandoc and xelatex are available
   */
  async checkDependencies(): Promise<{ pandoc: boolean; xelatex: boolean }> {
    const extendedPath = this.getExtendedPath();

    const checkCommand = async (command: string): Promise<boolean> => {
      return new Promise((resolve) => {
        const proc = spawn('which', [command], {
          env: { ...process.env, PATH: extendedPath }
        });
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
   * Export markdown to PDF using pandoc and xelatex
   */
  async exportToPDF(
    options: ExportOptions,
    onProgress?: (progress: PandocProgress) => void
  ): Promise<{ success: boolean; outputPath?: string; error?: string }> {
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
      const tempDir = join(tmpdir(), `cliodeck-export-${Date.now()}`);
      await mkdir(tempDir, { recursive: true });

      onProgress?.({ stage: 'preparing', message: 'Préparation des fichiers...', progress: 20 });

      // Try to load abstract from abstract.md if no abstract in metadata
      let abstract = options.metadata?.abstract;
      if (!abstract && (options.projectType === 'article' || options.projectType === 'book')) {
        // projectPath is the folder path for the project
        const abstractPath = join(options.projectPath, 'abstract.md');
        console.log('🔍 Looking for abstract at:', abstractPath);
        if (existsSync(abstractPath)) {
          const abstractContent = await readFile(abstractPath, 'utf-8');
          // Remove the "# Résumé" heading and trim
          abstract = abstractContent.replace(/^#\s*Résumé\s*\n*/i, '').trim();
          console.log('📄 Abstract loaded from file:', abstractPath);
          console.log('📄 Abstract content preview:', abstract.substring(0, 200));
        } else {
          console.log('⚠️ Abstract file not found at:', abstractPath);
        }
      }

      // Write markdown content (unescape citations that were escaped by Milkdown)
      const mdPath = join(tempDir, 'input.md');
      const cleanedContent = unescapeCitations(options.content);
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
      if (options.bibliographyPath && existsSync(options.bibliographyPath)) {
        bibPath = join(tempDir, 'bibliography.bib');
        const bibContent = await readFile(options.bibliographyPath, 'utf-8');
        await writeFile(bibPath, bibContent);
        console.log('📚 Bibliography copied:', options.bibliographyPath, '->', bibPath);
        console.log('📚 Bibliography size:', bibContent.length, 'bytes');
      } else {
        console.log('⚠️ No bibliography found at:', options.bibliographyPath);
      }

      // Build pandoc arguments
      // For presentations, use native Beamer support instead of custom template
      const pandocArgs = [
        mdPath,
        '-o', outputPath,
        '--pdf-engine=xelatex',
        '--from=markdown+autolink_bare_uris',
        '--pdf-engine-opt=-interaction=nonstopmode', // Don't stop on errors
      ];

      // Use different approach for presentations vs documents
      if (options.projectType === 'presentation') {
        // Use Pandoc's native Beamer support
        pandocArgs.push('--to=beamer');
        pandocArgs.push('--slide-level=1'); // H1 = new slide

        // Beamer-specific options via variables from config or defaults
        const cfg = options.beamerConfig || {};

        // Theme options
        const beamerTheme = cfg.theme || 'Madrid';
        const beamerColorTheme = cfg.colortheme || 'default';
        const beamerFontTheme = cfg.fonttheme || 'default';
        const beamerAspectRatio = cfg.aspectratio || '169';

        pandocArgs.push('-V', `theme:${beamerTheme}`);
        if (beamerColorTheme !== 'default') {
          pandocArgs.push('-V', `colortheme:${beamerColorTheme}`);
        }
        if (beamerFontTheme !== 'default') {
          pandocArgs.push('-V', `fonttheme:${beamerFontTheme}`);
        }
        pandocArgs.push('-V', `aspectratio:${beamerAspectRatio}`);

        // Title page options
        if (cfg.institute) {
          pandocArgs.push('-V', `institute:${cfg.institute}`);
        }
        if (cfg.logo) {
          pandocArgs.push('-V', `logo:${cfg.logo}`);
        }
        if (cfg.titlegraphic) {
          pandocArgs.push('-V', `titlegraphic:${cfg.titlegraphic}`);
        }

        // Section numbering
        if (cfg.showSectionNumber) {
          pandocArgs.push('-V', 'section-titles=true');
          pandocArgs.push('-V', 'numbersections=true');
        } else {
          pandocArgs.push('-V', 'numbersections=false');
        }

        // TOC in TOC
        if (cfg.sectionNumberInToc) {
          pandocArgs.push('-V', 'toc-numbering=true');
        }

        // Navigation symbols
        if (!cfg.navigation) {
          pandocArgs.push('-V', 'navigation:empty');
        }

        // Notes
        if (cfg.showNotes) {
          pandocArgs.push('-V', 'classoption=handout');
          pandocArgs.push('-V', 'notes=show');
        }

        // Incremental lists
        if (cfg.incremental) {
          pandocArgs.push('--incremental');
        }

        // Table of contents
        if (cfg.showToc) {
          pandocArgs.push('--toc');
          pandocArgs.push('--toc-depth=2');
        }

        // Advanced Beamer customization via header-includes
        const beamerCustomizations: string[] = [];

        // Frame numbering customization
        if (cfg.showFrameNumber) {
          if (cfg.frameNumberStyle === 'total') {
            beamerCustomizations.push('\\setbeamertemplate{footline}[frame number]');
          } else if (cfg.frameNumberStyle === 'simple') {
            beamerCustomizations.push('\\setbeamertemplate{footline}{\\hfill\\insertframenumber\\hspace{0.5cm}\\vspace{0.3cm}}');
          }
        } else {
          beamerCustomizations.push('\\setbeamertemplate{footline}{}');
        }

        // Custom footer with author/title/date
        if (cfg.showAuthorInFooter || cfg.showTitleInFooter || cfg.showDateInFooter) {
          const footerParts: string[] = [];
          footerParts.push('\\setbeamertemplate{footline}{');
          footerParts.push('  \\leavevmode%');
          footerParts.push('  \\hbox{%');

          if (cfg.showAuthorInFooter) {
            footerParts.push('    \\begin{beamercolorbox}[wd=.33\\paperwidth,ht=2.25ex,dp=1ex,center]{author in head/foot}%');
            footerParts.push('      \\usebeamerfont{author in head/foot}\\insertshortauthor%');
            footerParts.push('    \\end{beamercolorbox}%');
          }
          if (cfg.showTitleInFooter) {
            footerParts.push('    \\begin{beamercolorbox}[wd=.33\\paperwidth,ht=2.25ex,dp=1ex,center]{title in head/foot}%');
            footerParts.push('      \\usebeamerfont{title in head/foot}\\insertshorttitle%');
            footerParts.push('    \\end{beamercolorbox}%');
          }
          if (cfg.showDateInFooter) {
            footerParts.push('    \\begin{beamercolorbox}[wd=.34\\paperwidth,ht=2.25ex,dp=1ex,right]{date in head/foot}%');
            footerParts.push('      \\usebeamerfont{date in head/foot}\\insertshortdate{}\\hspace*{2em}');
            footerParts.push('      \\insertframenumber{} / \\inserttotalframenumber\\hspace*{2ex}%');
            footerParts.push('    \\end{beamercolorbox}%');
          }

          footerParts.push('  }%');
          footerParts.push('  \\vskip0pt%');
          footerParts.push('}');

          beamerCustomizations.push(...footerParts);
        }

        // TOC before each section
        if (cfg.tocBeforeSection && cfg.showToc) {
          beamerCustomizations.push(
            '\\AtBeginSection[]{',
            '  \\begin{frame}<beamer>',
            '    \\frametitle{Plan}',
            '    \\tableofcontents[currentsection]',
            '  \\end{frame}',
            '}'
          );
        }

        // Write header-includes file if we have customizations
        if (beamerCustomizations.length > 0) {
          const headerIncludesPath = join(tempDir, 'beamer-custom.tex');
          await writeFile(headerIncludesPath, beamerCustomizations.join('\n'));
          pandocArgs.push('--include-in-header', headerIncludesPath);
        }
      } else {
        // Use custom template for articles/books/notes
        pandocArgs.push('--template', templatePath);
        pandocArgs.push('--toc');
      }

      // Add metadata - escape special LaTeX characters
      const escapeLatex = (str: string): string => {
        return str
          .replace(/\\/g, '\\textbackslash{}')
          .replace(/[&%$#_{}]/g, '\\$&')
          .replace(/~/g, '\\textasciitilde{}')
          .replace(/\^/g, '\\textasciicircum{}');
      };

      if (options.metadata?.title) {
        pandocArgs.push('-M', `title=${escapeLatex(options.metadata.title)}`);
      }
      if (options.metadata?.author) {
        pandocArgs.push('-M', `author=${escapeLatex(options.metadata.author)}`);
      }
      if (options.metadata?.date) {
        pandocArgs.push('-M', `date=${options.metadata.date}`);
      }
      if (abstract) {
        pandocArgs.push('-M', `abstract=${escapeLatex(abstract)}`);
      }

      // Add bibliography if available
      if (bibPath) {
        pandocArgs.push('--bibliography', bibPath);
        pandocArgs.push('--citeproc');

        // Add CSL style if provided
        if (options.cslPath && existsSync(options.cslPath)) {
          pandocArgs.push('--csl', options.cslPath);
          console.log('📚 Using CSL style:', options.cslPath);
        } else {
          // Use default citation style
          pandocArgs.push('--metadata', 'reference-section-title=Références');
          pandocArgs.push('--metadata', 'suppress-bibliography=false');
        }
      }

      // Run pandoc
      onProgress?.({ stage: 'converting', message: 'Conversion en LaTeX...', progress: 40 });

      const extendedPath = this.getExtendedPath();

      await new Promise<void>((resolve, reject) => {
        console.log('📄 Running pandoc:', 'pandoc', pandocArgs.join(' '));

        const pandoc = spawn('pandoc', pandocArgs, {
          cwd: tempDir,
          env: { ...process.env, PATH: extendedPath },
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
      });

      onProgress?.({ stage: 'complete', message: 'Export terminé!', progress: 100 });

      // Cleanup temp directory
      await rm(tempDir, { recursive: true, force: true });

      console.log('✅ PDF exported successfully:', outputPath);
      return { success: true, outputPath };
    } catch (error: any) {
      console.error('❌ PDF export failed:', error);
      return { success: false, error: error.message };
    }
  }
}

export const pdfExportService = new PDFExportService();
