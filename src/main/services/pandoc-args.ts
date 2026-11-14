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

import { delimiter, join } from 'path';
import { CORE_SCHEMA, load as loadYaml } from 'js-yaml';
import { CHAPTERS_DIR, type BookSettings } from '../../../backend/types/book.js';
import { detectFrontmatterLines } from '../../editor/slides.js';
import type { OutcomeIssue } from '../../../backend/types/outcome.js';
import { getLanguage } from '../i18n.js';
import type { ExportImageErrorCode } from './export-time-limit.js';

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
  /** Titre et auteur saisis dans la fenêtre : ils l'emportent sur le document. */
  metadata?: { title?: string; author?: string };
  /**
   * Fichier de métadonnées déjà écrit par l'appelant (`metadataYaml`) : date, résumé, titre de la
   * bibliographie. Le front matter du document l'emporte sur lui.
   */
  metadataPath?: string;
  /** Bibliographie copiée dans le répertoire de travail, si elle existe. */
  bibPath?: string;
  /** Vrai quand CitationEngine a déjà inséré notes et bibliographie. */
  useEnginePipeline: boolean;
  cslPath?: string;
  /** Résolu par l'appelant : le fichier CSL existe-t-il réellement ? */
  cslAvailable: boolean;
  /** Fichier d'en-têtes beamer, si des personnalisations ont été écrites. */
  headerIncludesPath?: string;
  /**
   * Où pandoc cherche les images à chemin relatif (`--resource-path`) : il tourne dans le dossier
   * temporaire de l'export, où rien du projet ne se trouve (`projectResourcePaths`). Aucun ne
   * contient `path.delimiter`, sur lequel pandoc découpe la liste : `stageResourcePaths` remplace
   * un tel dossier par un lien du dossier de travail.
   */
  resourcePaths?: string[];
}

export const DEFAULT_BOOK_SETTINGS: BookSettings = {
  noteStyle: 'footnote',
  noteNumbering: 'continuous',
  bibliography: 'single',
  numberChapters: true,
  numberSections: false,
};

// MARK: - Petites décisions pures

/**
 * Les dossiers où chercher une image à chemin relatif, dans l'ordre. L'éditeur résout une image
 * relative au fichier ouvert (`CodeMirrorEditor`) : `images/plan.png` sous le projet pour un
 * article ou une présentation, sous `chapters/` pour un chapitre de livre. Un livre cherche donc
 * d'abord sous `chapters/` : chercher d'abord à la racine remettait dans le livre une autre image
 * que celle que l'auteur voit, quand le projet en a une du même nom. Le `../images/plan.png` d'un
 * chapitre retombe sous le projet par `chapters/`, et la racine reste en second recours.
 *
 * Un chapitre rattaché à la racine du projet (hors de `chapters/`) qui partage le nom d'une image
 * avec `chapters/` prendrait celle de `chapters/` : pandoc ne cherche que dans une liste, commune
 * à tout le document assemblé.
 */
export function projectResourcePaths(
  projectPath: string,
  projectType: 'article' | 'book' | 'presentation'
): string[] {
  return projectType === 'book' ? [join(projectPath, CHAPTERS_DIR), projectPath] : [projectPath];
}

/** Le sous-dossier du dossier de travail où l'export copie le logo et l'image de titre. */
export const BEAMER_STAGING_DIR = 'cliodeck-beamer';

/**
 * Le chemin, relatif au dossier de travail de l'export où xelatex tourne, sous lequel l'export y
 * copie le logo ou l'image de titre d'une présentation. Pandoc recopie la variable telle quelle
 * dans `\logo{\includegraphics{…}}` : un chemin absolu y portait les barres obliques inverses de
 * Windows (« Undefined control sequence »), le `#` ou le `%` d'un nom de dossier (« Illegal
 * parameter number », « File ended while scanning ») (S12-1-24). Le chemin fixe n'a que des
 * lettres, un trait d'union et une barre oblique, que LaTeX lit sous Windows aussi ; l'extension
 * est gardée quand elle n'a que des lettres et des chiffres, xelatex lisant le type de l'image sur
 * elle.
 *
 * Le nom fixe est rangé dans un sous-dossier (`BEAMER_STAGING_DIR`) : pandoc extrait les images du
 * document dans son dossier `media-…`, que xelatex lit avant son dossier courant (`TEXINPUTS`), et
 * une image `![…](logo.png)` du document y remplaçait en silence le logo du réglage.
 */
export function stagedBeamerImageName(kind: 'logo' | 'titlegraphic', source: string): string {
  const base = source.split(/[\\/]/).pop() ?? '';
  const ext = base.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? '';
  return `${BEAMER_STAGING_DIR}/${kind}${ext}`;
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

  if (cfg.showNotes) {
    // Les notes du présentateur, balisées en `::: notes` (`speakerNotesToPandoc`), sont des
    // `\note{…}` : beamer ne les imprime que sous cette option, chacune sur une page après sa
    // diapositive.
    out.push('\\setbeameroption{show notes}');
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
  // Les notes elles-mêmes : `buildBeamerCustomizations` (`-V notes=show` était inerte : le
  // gabarit beamer de pandoc n'a pas de variable `notes`). `handout` aplatit les pauses
  // (`--incremental`, `. . .`) : sans lui, chaque étape d'une diapositive aurait sa page de
  // notes, la même note répétée (mesuré : 6 pages au lieu de 4 pour deux diapositives notées,
  // dont une à une pause).
  if (cfg.showNotes) args.push('-V', 'classoption=handout');
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

/**
 * Métadonnées passées à pandoc, EN CLAIR.
 *
 * Ne pas échapper ici : une valeur passée en `-M clef=valeur` est une
 * MetaString, et pandoc l'échappe lui-même en écrivant le gabarit LaTeX.
 * Échapper en amont produisait un double échappement — `Dupont & Fils`
 * s'imprimait `Dupont \textbackslash& Fils` sur la page de titre, et le
 * résumé devenait illisible dès la première esperluette.
 *
 * En `-M`, seuls le titre et l'auteur saisis dans la fenêtre : un `-M` l'emporte sur le front
 * matter, et c'est ce que l'auteur a écrit pour cet export. Champ Auteur vide, aucun `-M author` :
 * l'auteur du document parle (S18-1-3). Le reste part par le fichier de métadonnées, que le
 * document remplace (`metadataYaml`).
 */
function metadataArgs(input: {
  metadata?: { title?: string; author?: string };
  metadataPath?: string;
}): string[] {
  const args: string[] = [];
  if (input.metadata?.title) {
    args.push('-M', `title=${input.metadata.title}`);
  }
  if (input.metadata?.author) {
    args.push('-M', `author=${input.metadata.author}`);
  }
  if (input.metadataPath) {
    args.push('--metadata-file', input.metadataPath);
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
    args.push('--metadata', 'suppress-bibliography=false');
  }
  // Le titre de la section (S12-1-11) part par le fichier de métadonnées, avec ou sans style :
  // en `--metadata`, il l'emportait sur un `reference-section-title` écrit par l'auteur (L10-4).
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

  if (input.resourcePaths?.length) {
    // Un seul argument : pas de shell, un projet dont le chemin contient une espace passe tel quel.
    // Pandoc découpe la liste sur `delimiter` : un dossier qui le contient arrive ici en lien
    // (`stageResourcePaths`).
    args.push(`--resource-path=${input.resourcePaths.join(delimiter)}`);
  }

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

  args.push(...metadataArgs({ metadata: input.metadata, metadataPath: input.metadataPath }));
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

/**
 * Titre de la section bibliographique, dans la langue de l'interface.
 *
 * Il est écrit DANS le document produit, pas dans l'écran : le laisser en
 * français donnait une section « Références » à un lecteur germanophone,
 * au milieu de son propre livre.
 */
export function referenceSectionTitle(): string {
  const titles: Record<string, string> = {
    fr: 'Références',
    en: 'References',
    de: 'Literatur',
  };
  return titles[getLanguage()] ?? titles.fr;
}

/**
 * La date que l'export imprime sous le titre d'un document qui n'en porte pas (Q42) : celle du
 * jour, dans la langue de l'interface, comme le titre de la bibliographie. « 14 novembre 2026 »,
 * « November 14, 2026 », « 14. November 2026 ». Elle part par le fichier de métadonnées
 * (`metadataYaml`) : le `date` du front matter l'emporte. `now` vient de l'appelant, ce module ne
 * lit pas l'horloge.
 */
export function documentDate(now: Date): string {
  const locales: Record<string, string> = { fr: 'fr-FR', en: 'en-US', de: 'de-DE' };
  return new Intl.DateTimeFormat(locales[getLanguage()] ?? locales.fr, { dateStyle: 'long' }).format(now);
}

// MARK: - Métadonnées que le document remplace

/**
 * Le fichier de métadonnées de l'export (`--metadata-file`) : ce que l'export propose et que le
 * document remplace. Pandoc donne le pas au front matter du document sur ce fichier, alors qu'un
 * `-M` l'emporte sur le front matter (vérifié avec pandoc 3.13) : la date et le titre de la
 * bibliographie partaient en `-M` et écrasaient ceux de l'auteur (S18-1-3).
 *
 * Pandoc lit chaque valeur comme du markdown : l'italique du résumé est rendu, là où `-M abstract=`
 * (une MetaString) l'imprimait avec ses astérisques (S12-1-6). Chaque valeur est une chaîne JSON,
 * que YAML relit telle quelle : ni `: `, ni `#`, ni un retour à la ligne n'y ouvrent une clé. Un
 * texte de plusieurs lignes finit par un saut de ligne : pandoc ne le lit en paragraphes qu'à
 * cette condition, et deux paragraphes du résumé sortaient sinon en un seul, coupé d'un saut de
 * ligne. Un champ vide ou absent n'est pas écrit.
 */
export function metadataYaml(fields: Readonly<Record<string, string | undefined>>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!value) continue;
    const text = value.includes('\n') && !value.endsWith('\n') ? `${value}\n` : value;
    lines.push(`${key}: ${JSON.stringify(text)}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Le front matter YAML en tête du document, tel que l'export le lit sans pandoc (générateur Word
 * interne, bibliographie du moteur) : ses champs, en chaînes, et le texte qui le suit. Même règle
 * de détection que l'éditeur et les présentations (`detectFrontmatterLines`). Un champ vide reste
 * un champ : `date: ""` retire la date, comme chez pandoc. Une date YAML (`2026-11-14`) reste la
 * chaîne écrite (schéma YAML de base, sans horodatage), plusieurs auteurs sont joints par une
 * virgule. Un YAML illisible est retiré du texte quand même, sans champ lu.
 */
export function documentFrontMatter(content: string): { body: string; fields: Record<string, string> } {
  const lines = content.split('\n', 102);
  const fm = detectFrontmatterLines(lines);
  if (!fm) return { body: content, fields: {} };
  const yamlEnd = lines.slice(0, fm.closingLine + 1).reduce((n, line) => n + line.length + 1, 0);
  const body = content.slice(Math.min(yamlEnd, content.length));
  const fields: Record<string, string> = {};
  try {
    const raw = loadYaml(lines.slice(1, fm.closingLine).join('\n'), { schema: CORE_SCHEMA });
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        const text = frontMatterText(value);
        if (text !== undefined) fields[key] = text;
      }
    }
  } catch {
    // YAML illisible : ce n'est pas du texte pour autant.
  }
  return { body, fields };
}

function frontMatterText(value: unknown): string | undefined {
  if (value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) {
    return value.join(', ');
  }
  return undefined;
}

/**
 * Ce que `project-manager` écrit dans l'`abstract.md` d'un article ou d'un livre neuf, sous
 * « # Résumé » : il invite l'auteur à écrire, ce n'est pas un résumé. Exporté tel quel, il
 * s'imprimait en résumé de tout article neuf.
 */
export const ABSTRACT_PLACEHOLDER = 'Résumé à compléter...';

/** Le résumé tel qu'il s'exporte : rien, tant que l'auteur n'a pas remplacé le texte de remplissage. */
export function exportableAbstract(text: string): string {
  return text.trim() === ABSTRACT_PLACEHOLDER ? '' : text;
}

/**
 * Le titre de la bibliographie d'un chapitre (bibliographie par chapitre), descendu d'un niveau.
 * Citeproc l'écrit en titre de niveau 1, `# Références {#bibliography .unnumbered}` (pandoc
 * 3.13) : dans le livre assemblé, ce `#` ouvrait un chapitre de plus après chaque chapitre. Il
 * devient une section du chapitre qu'il clôt, sans l'identifiant `bibliography`, que chaque
 * chapitre répéterait. Une autre forme, d'une autre version de pandoc, passe telle quelle : le
 * faux chapitre revient, sans rien perdre (`pdf-export-real.test.ts` le voit).
 */
export function demoteChapterBibliographyHeading(markdown: string): string {
  return markdown.replace(/^# (.+) \{#bibliography \.unnumbered\}$/gm, '## $1 {.unnumbered}');
}

// MARK: - Sortie d'erreur de pandoc

/** Clés que citeproc (pandoc) signale introuvables sur sa sortie d'erreur. */
export function pandocUnresolvedCitations(stderr: string): string[] {
  const keys = new Set<string>();
  for (const m of stderr.matchAll(/citation (\S+) not found/g)) keys.add(m[1]);
  return [...keys];
}

/**
 * Les ressources que pandoc n'a pas trouvées (« Could not fetch resource X: replacing image with
 * description », pandoc 3.x ; d'anciennes versions mettent le chemin entre apostrophes). Pandoc
 * remplace l'image par sa légende et réussit : c'est la seule trace qu'il en reste.
 *
 * Pandoc y écrit l'espace d'un nom de fichier en `%20` (`images/mon%20image.png`) : le nom est
 * rendu tel qu'il est sur le disque, pour que l'auteur le retrouve.
 */
export function pandocMissingResources(stderr: string): string[] {
  const files = new Set<string>();
  for (const m of stderr.matchAll(/Could not fetch resource '?(.+?)'?(?:: replacing image with description)?\r?$/gm)) {
    files.add(decodePercentEscapes(m[1]));
  }
  return [...files];
}

/**
 * Décode les suites `%XX` d'un chemin, une suite à la fois : un `%` que ne suivent pas deux
 * chiffres hexadécimaux (`images/100%.png`, que pandoc laisse tel quel) reste un `%`, là où
 * `decodeURIComponent` lèverait sur tout le chemin.
 */
function decodePercentEscapes(path: string): string {
  return path.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** Une seule réserve pour toutes les images introuvables : la modale la dit en une phrase. */
export function missingImagesWarnings(files: readonly string[]): OutcomeIssue[] {
  if (files.length === 0) return [];
  return [{ code: 'export.imagesNotFound', params: { files: files.join(', '), count: files.length } }];
}

/**
 * L'image qui fait échouer un export PDF, quand c'en est une : pandoc n'a pas su la convertir pour
 * xelatex (« Could not convert image »), et la compilation tombe ensuite sur elle. Une image SVG
 * demande `rsvg-convert` ; un format que ni pandoc ni xelatex ne lisent (WebP) ne passe pas.
 *
 * Pandoc nomme la copie qu'il a faite dans son dossier de travail (`…/media-<empreinte>/images/
 * schema.svg`) : la partie qui suit l'empreinte est le chemin écrit dans le document.
 */
export function pandocImageFailure(
  stderr: string
): { code: ExportImageErrorCode; params: { file: string } } | null {
  const m = stderr.match(/Could not convert image (.+?): (.*)$/m);
  if (!m) return null;
  const file = m[1].match(/[\\/]media-[0-9a-f]+[\\/](.+)$/)?.[1] ?? m[1];
  const code = /rsvg-convert/.test(m[2]) ? 'export.imageNeedsRsvgConvert' : 'export.imageNotConverted';
  return { code, params: { file } };
}
