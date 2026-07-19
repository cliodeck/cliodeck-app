/**
 * Book Type Definitions — manuscrit multi-fichiers
 *
 * Un projet « livre » est un manifeste (`project.json`) plus N fichiers
 * markdown : le manifeste porte l'ordre et les titres, les fichiers portent
 * le texte. Voir `docs/PLAN_chapitres-livre.md` §0.
 *
 * Ce module est importé des DEUX côtés (main et renderer) : il ne doit
 * dépendre ni d'Electron, ni de Node, ni de React.
 */

// ============================================================================
// Manifeste
// ============================================================================

/**
 * Rôle d'une pièce du manuscrit dans la structure de l'ouvrage.
 *
 * - `chapter` : chapitre numéroté du corps (`\mainmatter`) ;
 * - `front` : pièce liminaire — préface, remerciements, dédicace
 *   (`\frontmatter`, non numérotée) ;
 * - `back` : pièce finale — annexes, sources, index (`\backmatter`).
 *
 * L'arbitrage 6 du plan range introduction et conclusion parmi les
 * `chapter` (elles font partie du corps, même si l'auteur peut choisir de
 * ne pas les numéroter à l'export).
 */
export type ChapterKind = 'chapter' | 'front' | 'back';

/**
 * Une pièce du manuscrit. `filePath` est TOUJOURS relatif au dossier du
 * projet : un manifeste doit rester valable si le projet est déplacé ou
 * partagé (précédent : `bibliographySource.filePath`, `cslPath`).
 */
export interface Chapter {
  id: string;
  title: string;
  filePath: string;
  order: number;
  kind?: ChapterKind;
}

/**
 * Chapitre enrichi par la réconciliation disque (`getChapters`). Le
 * manifeste n'est jamais amputé d'une entrée dont le fichier a disparu :
 * elle est signalée, à charge pour l'interface de proposer la réparation.
 */
export interface ResolvedChapter extends Chapter {
  /** Le fichier référencé est introuvable sur le disque. */
  missing?: boolean;
}

/**
 * Fichier markdown trouvé dans le projet mais absent du manifeste. La
 * Phase 2 proposera de le rattacher ; en attendant il est simplement
 * signalé — décision cadre n°2 : on ne perd jamais de texte par
 * désynchronisation.
 */
export interface UnattachedFile {
  /** Chemin relatif au dossier du projet. */
  filePath: string;
  /** Titre déduit du premier `#` du fichier, si présent. */
  suggestedTitle?: string;
}

// ============================================================================
// Réglages d'ouvrage
// ============================================================================

/** Où les notes sont rendues à l'export (arbitrage 3bis). */
export type NoteStyle = 'footnote' | 'endnote-chapter' | 'endnote-book';

/** Numérotation des notes à l'export (arbitrage 3). */
export type NoteNumbering = 'continuous' | 'per-chapter';

/** Placement de la bibliographie (arbitrage 4). */
export type BibliographyPlacement = 'single' | 'per-chapter';

/**
 * Réglages d'appareil savant, propres à un ouvrage. Ils vivent dans
 * `project.json` (section `book`) et pilotent l'assemblage et le template
 * LaTeX en Phase 4 — aucun consommateur en Phase 1.
 */
export interface BookSettings {
  noteStyle: NoteStyle;
  noteNumbering: NoteNumbering;
  bibliography: BibliographyPlacement;
  numberChapters: boolean;
  numberSections: boolean;
}

/**
 * Défauts arbitrés le 2026-07-19 (plan §5) : notes de bas de page
 * numérotées en continu, bibliographie unique en fin d'ouvrage, chapitres
 * numérotés mais pas les sections.
 */
export const DEFAULT_BOOK_SETTINGS: BookSettings = {
  noteStyle: 'footnote',
  noteNumbering: 'continuous',
  bibliography: 'single',
  numberChapters: true,
  numberSections: false,
};

/**
 * Complète des réglages partiels (lus d'un `project.json` écrit par une
 * version antérieure, ou à la main) avec les défauts. Toute valeur
 * inconnue est ignorée au profit du défaut : un fichier édité à la main
 * ne doit pas pouvoir mettre l'export dans un état impossible.
 */
export function normalizeBookSettings(
  raw: Partial<BookSettings> | undefined | null
): BookSettings {
  const noteStyles: NoteStyle[] = ['footnote', 'endnote-chapter', 'endnote-book'];
  const noteNumberings: NoteNumbering[] = ['continuous', 'per-chapter'];
  const placements: BibliographyPlacement[] = ['single', 'per-chapter'];

  return {
    noteStyle:
      raw?.noteStyle && noteStyles.includes(raw.noteStyle)
        ? raw.noteStyle
        : DEFAULT_BOOK_SETTINGS.noteStyle,
    noteNumbering:
      raw?.noteNumbering && noteNumberings.includes(raw.noteNumbering)
        ? raw.noteNumbering
        : DEFAULT_BOOK_SETTINGS.noteNumbering,
    bibliography:
      raw?.bibliography && placements.includes(raw.bibliography)
        ? raw.bibliography
        : DEFAULT_BOOK_SETTINGS.bibliography,
    numberChapters:
      typeof raw?.numberChapters === 'boolean'
        ? raw.numberChapters
        : DEFAULT_BOOK_SETTINGS.numberChapters,
    numberSections:
      typeof raw?.numberSections === 'boolean'
        ? raw.numberSections
        : DEFAULT_BOOK_SETTINGS.numberSections,
  };
}

// ============================================================================
// Conventions de fichiers
// ============================================================================

/**
 * Dossier des chapitres, relatif au projet. Le préfixe numérique des noms
 * de fichiers (`01-…`) sert la lisibilité hors ClioDeck ; il n'a AUCUNE
 * valeur d'autorité — l'ordre vient du manifeste (arbitrage 7).
 */
export const CHAPTERS_DIR = 'chapters';

/**
 * Fichiers connus du projet qui ne sont pas des chapitres : ils ne doivent
 * jamais apparaître comme « non rattachés ».
 */
export const NON_CHAPTER_FILES = ['abstract.md', 'context.md', 'document.md'] as const;

/**
 * Nom de fichier pour un nouveau chapitre : préfixe d'ordre + titre en
 * kebab-case ASCII. Le résultat est un nom de fichier, pas un chemin.
 */
export function chapterFileName(order: number, title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // diacritiques décomposés
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const prefix = String(order + 1).padStart(2, '0');
  return `${prefix}-${slug || 'chapitre'}.md`;
}
