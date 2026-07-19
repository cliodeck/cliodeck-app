import { parser as markdownParser, GFM } from '@lezer/markdown';
import { Footnotes, PandocCitations } from './lezer-extensions/index.js';

/**
 * Plan d'un document par arbre Lezer (plan chapitres, Phase 3).
 *
 * Jumeau de `slides.ts` : parse unique, aucune regex de structure. Un `#`
 * dans un bloc de code n'est PAS un titre — c'est précisément ce qui
 * distingue ce helper d'un balayage ligne à ligne, et ce qui corrige la
 * limite connue de `replaceLeadingHeading` (Phase 2).
 *
 * Fonctions pures, sans DOM ni import ClioDeck.
 */

const outlineParser = markdownParser.configure([GFM, Footnotes, PandocCitations]);

export interface OutlineHeading {
  /** 1 pour `#`, 2 pour `##`… (Setext : 1 ou 2). */
  level: number;
  /** Texte du titre, marqueurs retirés. */
  text: string;
  /** Offsets du nœud titre entier (marqueurs compris). */
  from: number;
  to: number;
  /** 1-indexée, pour `revealLine`. */
  line: number;
}

const HEADING = /^(?:ATXHeading|SetextHeading)([1-6])$/;

/** Numéro de ligne (1-indexé) d'un offset. */
function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/**
 * Titre affiché : marqueurs ATX de tête et de queue retirés, première ligne
 * seulement (un titre Setext porte son soulignement dans le nœud).
 */
function headingText(source: string, from: number, to: number): string {
  return source
    .slice(from, to)
    .split('\n')[0]
    .replace(/^#{1,6}[ \t]*/, '')
    .replace(/[ \t]+#*[ \t]*$/, '')
    .trim();
}

/** Tous les titres du document, dans l'ordre, hors blocs de code. */
export function parseOutline(source: string): OutlineHeading[] {
  const tree = outlineParser.parse(source);
  const out: OutlineHeading[] = [];

  tree.iterate({
    enter: (node) => {
      // Les blocs de code sont opaques : leur contenu n'est pas du markdown.
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') return false;
      const match = HEADING.exec(node.name);
      if (!match) return undefined;
      out.push({
        level: Number(match[1]),
        text: headingText(source, node.from, node.to),
        from: node.from,
        to: node.to,
        line: lineNumberAt(source, node.from),
      });
      return false; // le contenu d'un titre n'a pas de sous-titre
    },
  });

  return out;
}

/**
 * Remplace le titre du chapitre — son premier titre de niveau 1 (arbitrage 1
 * du plan : le `#` EST le titre du chapitre) — ou l'ajoute en tête si le
 * fichier n'en a pas.
 *
 * Basé sur l'arbre : un `# …` situé dans un bloc de code ne peut pas être
 * pris pour le titre du chapitre (limite de la version ligne à ligne de la
 * Phase 2, levée ici).
 */
export function replaceLeadingHeading(content: string, title: string): string {
  const first = parseOutline(content).find((h) => h.level === 1);
  if (!first) return `# ${title}\n\n${content}`;
  // Le nœud titre englobe le `\r` d'un fichier CRLF : l'inclure dans le
  // remplacement convertirait cette ligne en LF. La fidélité octet par
  // octet prime (même famille que readDocText, cf. cm/fidelity.ts).
  let end = first.to;
  while (end > first.from && content[end - 1] === '\r') end--;
  return content.slice(0, first.from) + `# ${title}` + content.slice(end);
}

/**
 * Retire le titre de niveau 1 en tête d'un fichier, s'il y en a un.
 *
 * Sert aux pièces dont le titre est fourni par ailleurs — le résumé
 * (`abstract.md`) devient le champ `abstract` du document exporté, où un
 * « # Résumé » résiduel s'imprimerait littéralement (échappé en `\#`).
 * L'ancien filtre était une regex sur le mot « Résumé » accentué : un
 * fichier intitulé « # Abstract » ou « # Quatrième de couverture » passait
 * au travers. L'arbre ne se laisse pas prendre — y compris par un `#`
 * situé dans un bloc de code.
 */
export function stripLeadingHeading(content: string): string {
  const first = parseOutline(content).find((h) => h.level === 1);
  if (!first) return content.trim();
  // Rien d'autre que des blancs ne doit précéder : sinon le titre appartient
  // au corps du texte et le retirer trahirait le document.
  if (content.slice(0, first.from).trim() !== '') return content.trim();
  return content.slice(first.to).trim();
}
