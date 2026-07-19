import { parser as markdownParser, GFM } from '@lezer/markdown';
import { Footnotes, PandocCitations } from './lezer-extensions/index.js';

/**
 * Extraction des clés de citation par arbre Lezer (plan chapitres, Phase 3).
 *
 * Remplace la regex `\[@([^\]]+)\]` de « Vérifier les citations » : elle
 * comptait les `[@…]` des blocs de code, ratait les citations nues (`@clef`)
 * et traitait un cluster `[@a; @b]` comme une seule clé. Fonction pure, sans
 * DOM ni import ClioDeck.
 */

const citationParser = markdownParser.configure([GFM, Footnotes, PandocCitations]);

export interface CitationOccurrence {
  /** Clé sans le `@` (`lester1932`). */
  key: string;
  from: number;
  to: number;
  /** 1-indexée. */
  line: number;
}

/**
 * Toutes les clés citées d'un document, dans l'ordre. Un cluster
 * `[@a; @b]` produit deux occurrences ; le contenu des blocs de code n'en
 * produit aucune.
 */
export function collectCitationKeys(content: string): CitationOccurrence[] {
  const tree = citationParser.parse(content);
  const out: CitationOccurrence[] = [];

  tree.iterate({
    enter: (node) => {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') return false;
      if (node.name !== 'CitationKey') return undefined;
      out.push({
        key: content.slice(node.from, node.to),
        from: node.from,
        to: node.to,
        line: 0, // renseigné ci-dessous (un seul balayage de lignes)
      });
      return false;
    },
  });

  if (out.length > 0) {
    // Numéros de ligne en une passe, plutôt qu'un comptage par occurrence.
    let line = 1;
    let cursor = 0;
    for (const occ of out) {
      for (let i = cursor; i < occ.from; i++) {
        if (content[i] === '\n') line++;
      }
      cursor = occ.from;
      occ.line = line;
    }
  }

  return out;
}
