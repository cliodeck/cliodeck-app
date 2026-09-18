/**
 * Densité de texte d'un PDF extrait : un PDF sans couche de texte (scan non
 * OCRisé, « Imprimer en PDF » d'une page d'images) s'indexe sans erreur, mais
 * n'apporte rien à la recherche — et l'historien le croit consultable.
 *
 * Mesuré sur un projet réel (#132) :
 *   - Wang & Hoskins 2025 : 13 pages, 13 images, aucune police → 0 caractère ;
 *   - Star 1999 : 16 pages d'images, seul l'en-tête de téléchargement SAGE est
 *     du texte → ~70 caractères (hors espaces) par page.
 * Une page de texte courante en compte 1 500 à 3 000 ; une diapositive
 * sobre, une centaine et plus.
 *
 * Seuil : moins de 100 caractères **hors espaces** par page en moyenne. Hors
 * espaces pour qu'une mise en page aérée ne compte pas comme du texte.
 */

export const LOW_TEXT_CHARS_PER_PAGE = 100;

export interface TextDensity {
  /** Caractères hors espaces, par page, en moyenne (arrondi). */
  charsPerPage: number;
  /** Texte quasi absent : le PDF est très probablement une image. */
  lowText: boolean;
}

export function measureTextDensity(pages: ReadonlyArray<{ text: string }>): TextDensity {
  if (pages.length === 0) return { charsPerPage: 0, lowText: true };
  const chars = pages.reduce((n, p) => n + p.text.replace(/\s+/g, '').length, 0);
  const charsPerPage = Math.round(chars / pages.length);
  return { charsPerPage, lowText: charsPerPage < LOW_TEXT_CHARS_PER_PAGE };
}
