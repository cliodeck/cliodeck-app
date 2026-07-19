import { parser as markdownParser, GFM } from '@lezer/markdown';
import { Footnotes, PandocCitations } from './lezer-extensions/index.js';

/**
 * Statistiques de document par arbre Lezer (solde de
 * docs/TODO_barre-stats-document.md §2).
 *
 * Remplace les regex naïves de DocumentStats : les `[@…]`/`[^n]` des blocs
 * de code ne sont plus comptés, les notes sont des paires réf/déf distinctes
 * (identifiants libres compris), et le texte « prose » exclut la syntaxe
 * markdown au lieu de la deviner. Fonction pure, sans DOM ni import ClioDeck.
 */

const statsParser = markdownParser.configure([GFM, Footnotes, PandocCitations]);

export interface DocumentStatsCounts {
  /** Mots du texte hors syntaxe (frontmatter YAML inclus — parité historique). */
  words: number;
  /** Caractères hors espaces, sur le même texte. */
  chars: number;
  /** Caractères espaces compris, texte épuré et trimé. */
  charsWithSpaces: number;
  /** Nœuds Paragraph (y compris dans citations en bloc et listes). */
  paragraphs: number;
  /** Clés de citation (`CitationKey`) — un cluster `[@a; @b]` compte 2. */
  citations: number;
  /** Notes réelles : labels distincts présents en appel ET en définition. */
  footnotes: number;
}

// Conteneurs entièrement exclus du texte « prose » (descente stoppée).
const EXCLUDED_CONTAINERS = new Set([
  'FencedCode',
  'CodeBlock',
  'HTMLBlock',
  'PandocCitation',
]);

// Marqueurs de syntaxe exclus (leur contenu parent reste compté).
const EXCLUDED_MARKS = new Set([
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'EmphasisMark',
  'CodeMark',
  'CodeInfo',
  'StrikethroughMark',
  'LinkMark',
  'URL',
  'LinkTitle',
  'TableDelimiter',
  'TaskMarker',
  'HTMLTag',
  'FootnoteMark',
  'FootnoteLabel',
]);

/**
 * Texte « prose » d'un document : le markdown moins sa syntaxe.
 *
 * Blocs de code, HTML et clusters de citations sont retirés entièrement ;
 * les marqueurs (`#`, `>`, `*`, `[^1]`, URLs…) disparaissent en laissant
 * leur contenu. Le corps d'une note de bas de page reste, c'est du texte
 * que l'auteur a écrit.
 *
 * Extrait de `computeDocumentStats` pour être réutilisé par l'indexation
 * du manuscrit (corpus RAG) : un `[@clef]` ou un `[^1]` ne doit pas
 * polluer un embedding.
 */
export function extractProseText(content: string): string {
  return collect(content).plain.trim();
}

interface Collected {
  plain: string;
  paragraphs: number;
  citations: number;
  refLabels: Set<string>;
  defLabels: Set<string>;
}

function collect(content: string): Collected {
  const tree = statsParser.parse(content);

  let paragraphs = 0;
  let citations = 0;
  const refLabels = new Set<string>();
  const defLabels = new Set<string>();
  const excluded: Array<[number, number]> = [];

  tree.iterate({
    enter: (node) => {
      if (node.name === 'Paragraph') paragraphs += 1;

      // Le cluster entier est exclu du texte (return false plus bas) : ses
      // clés se comptent ici, avant de stopper la descente.
      if (node.name === 'PandocCitation') {
        citations += node.node.getChildren('CitationKey').length;
      }

      if (node.name === 'FootnoteReference' || node.name === 'FootnoteDefinition') {
        const label = node.node.getChild('FootnoteLabel');
        if (label) {
          const set = node.name === 'FootnoteReference' ? refLabels : defLabels;
          set.add(content.slice(label.from, label.to));
        }
        // Descendre : le corps d'une définition compte comme texte, et peut
        // contenir appels et citations.
        return true;
      }

      if (EXCLUDED_CONTAINERS.has(node.name)) {
        excluded.push([node.from, node.to]);
        return false; // rien à compter à l'intérieur
      }
      if (EXCLUDED_MARKS.has(node.name)) {
        excluded.push([node.from, node.to]);
        return true;
      }
      return true;
    },
  });

  // Texte « prose » = document moins les plages exclues (triées, fusionnées).
  excluded.sort((a, b) => a[0] - b[0]);
  let plain = '';
  let cursor = 0;
  for (const [from, to] of excluded) {
    if (from > cursor) plain += content.slice(cursor, from);
    cursor = Math.max(cursor, to);
  }
  plain += content.slice(cursor);
  return { plain, paragraphs, citations, refLabels, defLabels };
}

export function computeDocumentStats(content: string): DocumentStatsCounts {
  const { plain, paragraphs, citations, refLabels, defLabels } =
    collect(content);
  const trimmed = plain.trim();

  const words = trimmed.length === 0 ? 0 : (trimmed.match(/\S+/g) ?? []).length;

  let footnotes = 0;
  for (const label of refLabels) {
    if (defLabels.has(label)) footnotes += 1;
  }

  return {
    words,
    chars: trimmed.replace(/\s/g, '').length,
    charsWithSpaces: trimmed.length,
    paragraphs,
    citations,
    footnotes,
  };
}
