import { parser as markdownParser, GFM } from '@lezer/markdown';
import type { Tree } from '@lezer/common';
import { Footnotes, PandocCitations } from './lezer-extensions/index.js';

/**
 * Outils footnotes basés sur le parse Lezer (plan CM6, Phase 3b).
 *
 * Remplace les regex naïves : un `[^99]` dans un bloc de code n'est PAS une
 * note (bug trouvé en vérification Phase 1 — la numérotation sautait à 100
 * sur le corpus kitchen-sink). Fonctions pures, sans DOM ni import ClioDeck.
 */

const scholarlyParser = markdownParser.configure([
  GFM,
  Footnotes,
  PandocCitations,
]);

export interface FootnoteOccurrence {
  /** Label sans les marqueurs (`1`, `lester-danzig`). */
  label: string;
  /** Positions du label dans le document. */
  from: number;
  to: number;
  kind: 'reference' | 'definition';
}

function parse(content: string): Tree {
  return scholarlyParser.parse(content);
}

/** Toutes les occurrences de notes (appels et définitions), ordre du document. */
export function collectFootnotes(content: string): FootnoteOccurrence[] {
  const out: FootnoteOccurrence[] = [];
  parse(content).iterate({
    enter: (node) => {
      if (node.name !== 'FootnoteReference' && node.name !== 'FootnoteDefinition') {
        return;
      }
      const label = node.node.getChild('FootnoteLabel');
      if (label) {
        out.push({
          label: content.slice(label.from, label.to),
          from: label.from,
          to: label.to,
          kind: node.name === 'FootnoteReference' ? 'reference' : 'definition',
        });
      }
      // Les définitions peuvent contenir des appels dans leur corps :
      // continuer la descente.
    },
  });
  return out;
}

/**
 * Prochain numéro de note disponible : max des labels numériques réels + 1.
 * Ignore le contenu des blocs de code par construction (parse Lezer).
 */
export function nextFootnoteNumber(content: string): number {
  let max = 0;
  for (const occ of collectFootnotes(content)) {
    if (/^\d+$/.test(occ.label)) {
      max = Math.max(max, parseInt(occ.label, 10));
    }
  }
  return max + 1;
}

/**
 * Renumérotation manuelle (arbitrage 2 du plan : commande explicite, jamais
 * silencieuse). Les labels NUMÉRIQUES sont renumérotés 1..n dans l'ordre
 * d'apparition des appels ; les définitions orphelines numériques passent en
 * queue de numérotation ; les identifiants libres restent intacts. Le reste
 * du document est préservé octet pour octet.
 */
export function renumberFootnotes(
  content: string,
  startAt = 1
): {
  content: string;
  changed: boolean;
  /** Prochain numéro libre — sert la numérotation continue d'un ouvrage. */
  nextNumber: number;
} {
  const occurrences = collectFootnotes(content);

  const mapping = new Map<string, string>();
  let next = startAt;
  const assign = (label: string) => {
    if (/^\d+$/.test(label) && !mapping.has(label)) {
      mapping.set(label, String(next++));
    }
  };
  for (const occ of occurrences) {
    if (occ.kind === 'reference') assign(occ.label);
  }
  for (const occ of occurrences) {
    if (occ.kind === 'definition') assign(occ.label);
  }

  let changed = false;
  for (const [oldLabel, newLabel] of mapping) {
    if (oldLabel !== newLabel) changed = true;
  }
  if (!changed) return { content, changed: false, nextNumber: next };

  // Remplacement de la fin vers le début : les positions restent valides.
  let out = content;
  for (let i = occurrences.length - 1; i >= 0; i--) {
    const occ = occurrences[i];
    const replacement = mapping.get(occ.label);
    if (replacement !== undefined && replacement !== occ.label) {
      out = out.slice(0, occ.from) + replacement + out.slice(occ.to);
    }
  }
  return { content: out, changed: true, nextNumber: next };
}

/** Un document du manuscrit, dans l'ordre du manifeste. */
export interface ManuscriptDoc {
  /** Identifiant du document (chemin relatif du chapitre). */
  key: string;
  content: string;
}

export interface RenumberedDoc extends ManuscriptDoc {
  changed: boolean;
}

/**
 * Renumérotation à l'échelle d'un manuscrit (plan chapitres, Phase 3).
 *
 * `continuous` : la numérotation court d'un chapitre à l'autre dans l'ordre
 * du manifeste — le chapitre 2 reprend là où le 1 s'est arrêté.
 * `per-chapter` : chaque chapitre repart à 1 (comportement d'un document
 * isolé, appliqué fichier par fichier).
 *
 * Fonction PURE : elle ne touche à aucun fichier. L'écriture atomique est
 * l'affaire de l'appelant, qui décide quoi faire des documents `changed`.
 */
export function renumberManuscript(
  docs: readonly ManuscriptDoc[],
  mode: 'continuous' | 'per-chapter' = 'continuous'
): RenumberedDoc[] {
  let next = 1;
  return docs.map((doc) => {
    const result = renumberFootnotes(doc.content, mode === 'continuous' ? next : 1);
    if (mode === 'continuous') next = result.nextNumber;
    return { key: doc.key, content: result.content, changed: result.changed };
  });
}
