/**
 * Découpage d'un chapitre de manuscrit pour l'indexation RAG.
 *
 * Quatrième corpus (item 25 des audits) : jusqu'ici le RAG ne connaissait
 * que les sources externes — PDF de bibliographie, archives Tropy, vault
 * Obsidian. Rien ne regardait le texte que l'historien est en train
 * d'écrire, si bien que « qu'ai-je déjà écrit sur Danzig ? » restait sans
 * réponse. Passé quelques chapitres, c'est pourtant la question la plus
 * naturelle.
 *
 * Deux principes, hérités des chantiers précédents :
 *
 *  - **découpage par l'arbre, jamais par regex** : `parseOutline` donne les
 *    titres réels (un `#` dans un bloc de code n'ouvre pas une section) ;
 *  - **texte épuré avant embedding** : `extractProseText` retire la syntaxe
 *    markdown, les clusters `[@clef]` et les marqueurs `[^1]`. Un embedding
 *    de « [@lester1932] » n'apprend rien ; le corps d'une note, si.
 *
 * Fonctions pures : ni I/O, ni Electron. Le service d'indexation les
 * appelle, les tests les exercent directement.
 */

import { parseOutline } from '../../../src/editor/outline.js';
import { extractProseText } from '../../../src/editor/document-stats.js';

/** Cible de taille d'un chunk, en caractères (aligné sur le vault Obsidian). */
export const CHUNK_CHAR_TARGET = 2000;
/** Recouvrement entre deux chunks d'une même section. */
export const CHUNK_OVERLAP = 200;
/**
 * Version du découpage, mêlée à l'empreinte de contenu par l'indexeur du
 * manuscrit. Sans elle, un changement ici ne réindexait rien : l'empreinte
 * porte sur le texte brut, pas sur le texte extrait, et l'index gardait les
 * anciens chunks jusqu'à la prochaine modification de chaque chapitre — des
 * mois, sur un livre. À incrémenter à chaque changement de `extractProseText`
 * ou de ce fichier qui modifie les chunks produits.
 *
 *  1 — découpage d'origine (rc.4) ;
 *  2 — citations en bloc et notes de référence hors du texte embarqué
 *      (docs/poids-du-manuscrit.md, palier 3).
 */
export const CHUNKER_VERSION = 2;
/**
 * En deçà, le corps d'une note est une référence (« Lester, p. 45 »), pas un
 * argument : il sort du texte embarqué du manuscrit.
 */
export const FOOTNOTE_MIN_WORDS = 25;

export interface ChunkOptions {
  /**
   * Retirer ce que l'auteur cite plutôt qu'écrit : blocs de citation et
   * notes de référence. Vrai pour le manuscrit — un passage cité d'une
   * source revenait comme source [N] et comme manuscrit [M] — ; faux pour
   * les notes de lecture, dont les citations sont le propos.
   */
  dropQuotations?: boolean;
}

export interface ManuscriptChunk {
  /** Index du chunk dans le chapitre, 0-based. */
  chunkIndex: number;
  /** Texte épuré, prêt à embarquer. */
  content: string;
  /** Titre de la section d'où vient le chunk (le plus proche au-dessus). */
  sectionTitle?: string;
  /** Ligne (1-indexée) du début de la section, pour ramener l'auteur au texte. */
  line: number;
}

interface Section {
  title?: string;
  /** Markdown brut de la section, titre compris. */
  markdown: string;
  line: number;
}

/**
 * Coupe un chapitre en sections sur ses titres. Le préambule éventuel
 * (texte avant le premier titre) forme une section sans titre.
 */
function splitIntoSections(markdown: string): Section[] {
  const headings = parseOutline(markdown);
  if (headings.length === 0) {
    return [{ markdown, line: 1 }];
  }

  const sections: Section[] = [];
  const first = headings[0];
  if (first.from > 0 && markdown.slice(0, first.from).trim()) {
    sections.push({ markdown: markdown.slice(0, first.from), line: 1 });
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].from;
    const end = i + 1 < headings.length ? headings[i + 1].from : markdown.length;
    sections.push({
      title: headings[i].text,
      markdown: markdown.slice(start, end),
      line: headings[i].line,
    });
  }
  return sections;
}

/**
 * Coupe un texte long sur une frontière de phrase ou de paragraphe plutôt
 * qu'au milieu d'un mot — même heuristique que l'indexeur de vault, pour
 * que les deux corpus se comportent pareil.
 */
function splitLongText(text: string): string[] {
  if (text.length <= CHUNK_CHAR_TARGET) return [text];
  const out: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + CHUNK_CHAR_TARGET, text.length);
    let chunkEnd = end;
    if (end < text.length) {
      const lookback = text.slice(Math.max(pos, end - 200), end);
      const bestBreak = Math.max(
        lookback.lastIndexOf('\n\n'),
        lookback.lastIndexOf('. '),
        lookback.lastIndexOf('! '),
        lookback.lastIndexOf('? ')
      );
      if (bestBreak > 0) chunkEnd = end - lookback.length + bestBreak + 2;
    }
    const piece = text.slice(pos, chunkEnd).trim();
    if (piece) out.push(piece);
    if (chunkEnd >= text.length) break;
    const next = chunkEnd - CHUNK_OVERLAP;
    pos = next > pos ? next : chunkEnd;
  }
  return out;
}

/**
 * Découpe un chapitre en chunks indexables. Le titre de section est
 * préfixé au texte : il porte du sens que l'embedding doit voir
 * (« Le Volkstag » situe un paragraphe qui ne nomme peut-être jamais
 * Danzig).
 */
export function chunkManuscriptChapter(
  markdown: string,
  options: ChunkOptions = {}
): ManuscriptChunk[] {
  const chunks: ManuscriptChunk[] = [];
  let chunkIndex = 0;
  const proseOptions = options.dropQuotations
    ? { dropBlockquotes: true, minFootnoteWords: FOOTNOTE_MIN_WORDS }
    : {};

  for (const section of splitIntoSections(markdown)) {
    const prose = extractProseText(section.markdown, proseOptions);
    if (!prose) continue;

    // Une section réduite à son propre titre n'a pas de corps : l'indexer
    // produirait un extrait sans contenu, qui remonterait dans les
    // résultats sans rien apprendre à personne.
    if (section.title && prose.trim() === section.title.trim()) continue;

    for (const piece of splitLongText(prose)) {
      chunks.push({
        chunkIndex,
        content: piece,
        sectionTitle: section.title,
        line: section.line,
      });
      chunkIndex += 1;
    }
  }

  return chunks;
}
