/**
 * Construction des arguments pandoc — couche PURE et testable.
 *
 * Cette logique vivait en ligne dans `exportToPDF`, mêlée à la création du
 * répertoire temporaire, à l'écriture des fichiers et au `spawn`. Elle n'a
 * donc jamais pu être testée autrement qu'en produisant des PDF à la main —
 * alors qu'elle porte désormais l'assemblage des chapitres, les trois styles
 * de notes, la numérotation des titres et la bibliographie par chapitre
 * (audit du 2026-07-19, item 24). C'est aussi le point d'entrée des chantiers
 * à venir (index, références croisées).
 *
 * Règle du module : aucune fonction n'accède au disque, ne lance de processus
 * ni ne lit l'horloge. Tout ce qui dépend du monde (existence d'un fichier
 * CSL, chemin du répertoire temporaire) est résolu par l'appelant et passé en
 * paramètre.
 */

import type { BookSettings } from '../../../backend/types/book.js';

// MARK: - Types

export interface BeamerConfig {
  theme?: string;
  colortheme?: string;
  fonttheme?: string;
  aspectratio?: string;
  navigation?: boolean;
  showNotes?: boolean;
  institute?: string;
  logo?: string;
  titlegraphic?: string;
  showToc?: boolean;
  tocBeforeSection?: boolean;
  showFrameNumber?: boolean;
  frameNumberStyle?: 'total' | 'simple' | 'none';
  showSectionNumber?: boolean;
  sectionNumberInToc?: boolean;
  showAuthorInFooter?: boolean;
  showTitleInFooter?: boolean;
  showDateInFooter?: boolean;
  incremental?: boolean;
  overlays?: boolean;
}

export interface PandocArgsInput {
  /** Chemin du markdown d'entrée (déjà écrit par l'appelant). */
  mdPath: string;
  outputPath: string;
  /** Template LaTeX maison — ignoré pour les présentations (beamer natif). */
  templatePath: string;
  projectType: 'article' | 'book' | 'presentation';
  bookSettings?: BookSettings;
  beamerConfig?: BeamerConfig;
  metadata?: { title?: string; author?: string; date?: string };
  /** Résumé déjà résolu (métadonnée explicite ou `abstract.md` dépouillé). */
  abstract?: string;
  /** Bibliographie copiée dans le répertoire de travail, si elle existe. */
  bibPath?: string;
  /** Vrai quand CitationEngine a déjà inséré notes et bibliographie. */
  useEnginePipeline: boolean;
  cslPath?: string;
  /** Résolu par l'appelant : le fichier CSL existe-t-il réellement ? */
  cslAvailable: boolean;
  /** Fichier d'en-têtes beamer, si des personnalisations ont été écrites. */
  headerIncludesPath?: string;
}

export const DEFAULT_BOOK_SETTINGS: BookSettings = {
  noteStyle: 'footnote',
  noteNumbering: 'continuous',
  bibliography: 'single',
  numberChapters: true,
  numberSections: false,
};

// MARK: - Petites décisions pures

const LATEX_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

/**
 * Échappe les caractères que LaTeX interpréterait dans une métadonnée.
 *
 * Passe UNIQUE, à dessein : la version d'origine enchaînait quatre `replace`,
 * si bien que les accolades produites par `\textbackslash{}` étaient
 * ré-échappées par la passe suivante — un titre contenant une barre oblique
 * inverse s'imprimait `\textbackslash\{\}` au lieu de `\`. Bug préexistant
 * révélé par ces tests (item 24).
 */
export function escapeLatex(str: string): string {
  return str.replace(/[\\&%$#_{}~^]/g, (ch) => LATEX_ESCAPES[ch] ?? ch);
}

/** Réglages d'ouvrage complétés par les défauts. */
export function resolveBookSettings(settings?: BookSettings): BookSettings {
  return { ...DEFAULT_BOOK_SETTINGS, ...(settings ?? {}) };
}

/**
 * Profondeur de numérotation en classe `book` :
 * -1 = rien, 0 = chapitres seuls, 1 = chapitres et sections.
 */
export function computeSecnumdepth(settings?: BookSettings): number {
  if (settings?.numberSections) return 1;
  if (settings?.numberChapters === false) return -1;
  return 0;
}

/**
 * Bibliographie par chapitre : possible seulement si une bibliographie
 * existe ET que le pipeline CitationEngine ne tourne pas (il inline ses
 * propres notes, citeproc n'aurait plus rien à résoudre). Sinon repli
 * silencieux mais journalisé sur une bibliographie unique.
 */
export function resolveBibliographyMode(input: {
  settings: BookSettings;
  bibliographyAvailable: boolean;
  useEngine: boolean;
}): { perChapter: boolean; warning?: string } {
  const wanted = input.settings.bibliography === 'per-chapter';
  const perChapter = wanted && input.bibliographyAvailable && !input.useEngine;
  if (wanted && !perChapter) {
    return {
      perChapter: false,
      warning:
        'Bibliographie par chapitre ignorée (bibliographie absente ou pipeline CitationEngine actif) : repli sur une bibliographie unique.',
    };
  }
  return { perChapter };
}

// MARK: - Blocs d'arguments

/** Personnalisations beamer à écrire en `--include-in-header`. */
export function buildBeamerCustomizations(cfg: BeamerConfig = {}): string[] {
  const out: string[] = [];

  if (cfg.showFrameNumber) {
    if (cfg.frameNumberStyle === 'total') {
      out.push('\\setbeamertemplate{footline}[frame number]');
    } else if (cfg.frameNumberStyle === 'simple') {
      out.push(
        '\\setbeamertemplate{footline}{\\hfill\\insertframenumber\\hspace{0.5cm}\\vspace{0.3cm}}'
      );
    }
  } else {
    out.push('\\setbeamertemplate{footline}{}');
  }

  if (cfg.showAuthorInFooter || cfg.showTitleInFooter || cfg.showDateInFooter) {
    out.push('\\setbeamertemplate{footline}{');
    out.push('  \\leavevmode%');
    out.push('  \\hbox{%');
    if (cfg.showAuthorInFooter) {
      out.push(
        '    \\begin{beamercolorbox}[wd=.33\\paperwidth,ht=2.25ex,dp=1ex,center]{author in head/foot}%'
      );
      out.push('      \\usebeamerfont{author in head/foot}\\insertshortauthor%');
      out.push('    \\end{beamercolorbox}%');
    }
    if (cfg.showTitleInFooter) {
      out.push(
        '    \\begin{beamercolorbox}[wd=.33\\paperwidth,ht=2.25ex,dp=1ex,center]{title in head/foot}%'
      );
      out.push('      \\usebeamerfont{title in head/foot}\\insertshorttitle%');
      out.push('    \\end{beamercolorbox}%');
    }
    if (cfg.showDateInFooter) {
      out.push(
        '    \\begin{beamercolorbox}[wd=.34\\paperwidth,ht=2.25ex,dp=1ex,right]{date in head/foot}%'
      );
      out.push(
        '      \\usebeamerfont{date in head/foot}\\insertshortdate{}\\hspace*{2em}'
      );
      out.push(
        '      \\insertframenumber{} / \\inserttotalframenumber\\hspace*{2ex}%'
      );
      out.push('    \\end{beamercolorbox}%');
    }
    out.push('  }%');
    out.push('  \\vskip0pt%');
    out.push('}');
  }

  if (cfg.tocBeforeSection && cfg.showToc) {
    out.push(
      '\\AtBeginSection[]{',
      '  \\begin{frame}<beamer>',
      '    \\frametitle{Plan}',
      '    \\tableofcontents[currentsection]',
      '  \\end{frame}',
      '}'
    );
  }

  return out;
}

/** Arguments propres aux présentations (beamer natif de pandoc). */
function presentationArgs(
  cfg: BeamerConfig,
  headerIncludesPath?: string
): string[] {
  const args: string[] = ['--to=beamer', '--slide-level=1'];

  const theme = cfg.theme || 'Madrid';
  const colortheme = cfg.colortheme || 'default';
  const fonttheme = cfg.fonttheme || 'default';
  const aspectratio = cfg.aspectratio || '169';

  args.push('-V', `theme:${theme}`);
  if (colortheme !== 'default') args.push('-V', `colortheme:${colortheme}`);
  if (fonttheme !== 'default') args.push('-V', `fonttheme:${fonttheme}`);
  args.push('-V', `aspectratio:${aspectratio}`);

  if (cfg.institute) args.push('-V', `institute:${cfg.institute}`);
  if (cfg.logo) args.push('-V', `logo:${cfg.logo}`);
  if (cfg.titlegraphic) args.push('-V', `titlegraphic:${cfg.titlegraphic}`);

  if (cfg.showSectionNumber) {
    args.push('-V', 'section-titles=true');
    args.push('-V', 'numbersections=true');
  } else {
    args.push('-V', 'numbersections=false');
  }

  if (cfg.sectionNumberInToc) args.push('-V', 'toc-numbering=true');
  if (!cfg.navigation) args.push('-V', 'navigation:empty');
  if (cfg.showNotes) {
    args.push('-V', 'classoption=handout');
    args.push('-V', 'notes=show');
  }
  if (cfg.incremental) args.push('--incremental');
  if (cfg.showToc) {
    args.push('--toc');
    args.push('--toc-depth=2');
  }
  if (headerIncludesPath) {
    args.push('--include-in-header', headerIncludesPath);
  }

  return args;
}

/**
 * Arguments des documents (article / livre) : template maison, table des
 * matières, et pour un livre la division de premier niveau, la numérotation
 * et les notes de fin.
 */
function documentArgs(input: {
  templatePath: string;
  projectType: 'article' | 'book';
  bookSettings?: BookSettings;
}): string[] {
  const args: string[] = ['--template', input.templatePath, '--toc'];

  if (input.projectType === 'book') {
    // SANS cette option, pandoc rend un `#` en \section : la classe book
    // n'émet aucun \chapter, la table des matières se réduit aux sections et
    // les en-têtes recto/verso (nourris par \chaptermark) restent vides.
    // Vérifié empiriquement (plan §1.2).
    args.push('--top-level-division=chapter');
    args.push('-V', `secnumdepth=${computeSecnumdepth(input.bookSettings)}`);

    const style = input.bookSettings?.noteStyle;
    if (style === 'endnote-chapter' || style === 'endnote-book') {
      args.push('-V', 'endnotes=true');
    }
  }

  return args;
}

/** Métadonnées passées à pandoc, échappées pour LaTeX. */
function metadataArgs(input: {
  metadata?: { title?: string; author?: string; date?: string };
  abstract?: string;
}): string[] {
  const args: string[] = [];
  if (input.metadata?.title) {
    args.push('-M', `title=${escapeLatex(input.metadata.title)}`);
  }
  if (input.metadata?.author) {
    args.push('-M', `author=${escapeLatex(input.metadata.author)}`);
  }
  if (input.metadata?.date) {
    args.push('-M', `date=${input.metadata.date}`);
  }
  if (input.abstract) {
    args.push('-M', `abstract=${escapeLatex(input.abstract)}`);
  }
  return args;
}

/**
 * Bibliographie : ignorée quand CitationEngine a déjà inséré notes et
 * bibliographie en markdown — pandoc n'a alors rien à résoudre.
 */
function bibliographyArgs(input: {
  bibPath?: string;
  useEnginePipeline: boolean;
  cslPath?: string;
  cslAvailable: boolean;
}): string[] {
  if (!input.bibPath || input.useEnginePipeline) return [];

  const args = ['--bibliography', input.bibPath, '--citeproc'];
  if (input.cslPath && input.cslAvailable) {
    args.push('--csl', input.cslPath);
  } else {
    args.push('--metadata', 'reference-section-title=Références');
    args.push('--metadata', 'suppress-bibliography=false');
  }
  return args;
}

// MARK: - Composition

/**
 * Ligne de commande pandoc complète. L'ordre reproduit exactement celui de
 * l'ancienne construction en ligne : base, bloc présentation OU document,
 * métadonnées, bibliographie.
 */
export function buildPandocArgs(input: PandocArgsInput): string[] {
  const args: string[] = [
    input.mdPath,
    '-o',
    input.outputPath,
    '--pdf-engine=xelatex',
    '--from=markdown+autolink_bare_uris',
    '--pdf-engine-opt=-interaction=nonstopmode',
  ];

  if (input.projectType === 'presentation') {
    args.push(
      ...presentationArgs(input.beamerConfig ?? {}, input.headerIncludesPath)
    );
  } else {
    args.push(
      ...documentArgs({
        templatePath: input.templatePath,
        projectType: input.projectType,
        bookSettings: input.bookSettings,
      })
    );
  }

  args.push(...metadataArgs({ metadata: input.metadata, abstract: input.abstract }));
  args.push(
    ...bibliographyArgs({
      bibPath: input.bibPath,
      useEnginePipeline: input.useEnginePipeline,
      cslPath: input.cslPath,
      cslAvailable: input.cslAvailable,
    })
  );

  return args;
}
