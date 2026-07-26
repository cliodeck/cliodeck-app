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

/**
 * Appel de note à l'intérieur d'un bloc HTML : `[^label]` non suivi de `:`.
 *
 * Lezer traite un `HTMLBlock` comme opaque et n'y cherche pas d'inline —
 * pandoc, lui, y voit très bien les notes (mesuré : un `[^1]` dans un
 * `<div>` rend un `\footnote`). Sans ce rattrapage, le préfixage par
 * chapitre renommait la DÉFINITION sans toucher à l'APPEL resté dans
 * l'encadré : les deux devenaient orphelins et le texte de la note
 * disparaissait du livre.
 */
const HTML_FOOTNOTE_REFERENCE = /\[\^([^\]\s]+)\](?!:)/g;

/** Toutes les occurrences de notes (appels et définitions), ordre du document. */
export function collectFootnotes(content: string): FootnoteOccurrence[] {
  const out: FootnoteOccurrence[] = [];
  parse(content).iterate({
    enter: (node) => {
      if (node.name === 'HTMLBlock') {
        // Bloc opaque pour Lezer : on y cherche les appels nous-mêmes.
        const block = content.slice(node.from, node.to);
        HTML_FOOTNOTE_REFERENCE.lastIndex = 0;
        for (const m of block.matchAll(HTML_FOOTNOTE_REFERENCE)) {
          const labelStart = node.from + (m.index ?? 0) + 2; // après `[^`
          out.push({
            label: m[1],
            from: labelStart,
            to: labelStart + m[1].length,
            kind: 'reference',
          });
        }
        return false; // rien d'autre à y chercher
      }
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
  // L'ordre du document n'est plus garanti : les appels d'un bloc HTML sont
  // ajoutés à la visite du bloc, pas à leur position exacte dans la suite.
  return out.sort((a, b) => a.from - b.from);
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

/**
 * Préfixe tous les identifiants de notes d'un document (plan chapitres,
 * §1.1 stratégie D). `[^1]` devient `[^ch3-1]`, appels ET définitions.
 *
 * C'est ce qui rend l'assemblage d'un manuscrit sûr : concaténer deux
 * chapitres utilisant chacun `[^1]` fait rendre à pandoc LA MÊME note aux
 * deux endroits — le texte du premier chapitre est silencieusement remplacé
 * par celui du second (vérifié empiriquement, cf. plan §1.1). Préfixer par
 * chapitre isole les espaces de noms sans toucher aux ancres de renvois,
 * contrairement à `--file-scope` qui, lui, casse les liens inter-chapitres.
 *
 * Les identifiants sont pris sur l'arbre Lezer : un `[^99]` dans un bloc de
 * code n'est pas une note et reste intact. Le reste du document est
 * préservé octet pour octet.
 */
export function prefixFootnoteLabels(content: string, prefix: string): string {
  if (!prefix) return content;
  const occurrences = collectFootnotes(content);
  if (occurrences.length === 0) return content;

  // Remplacement de la fin vers le début : les positions restent valides.
  let out = content;
  for (let i = occurrences.length - 1; i >= 0; i--) {
    const occ = occurrences[i];
    out = out.slice(0, occ.from) + `${prefix}-${occ.label}` + out.slice(occ.to);
  }
  return out;
}
