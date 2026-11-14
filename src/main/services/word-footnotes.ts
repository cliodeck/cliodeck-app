import { parser as markdownParser, GFM } from '@lezer/markdown';
import { collectFootnoteDefinitions } from '../../editor/footnote-tools.js';
import { Footnotes, PandocCitations } from '../../editor/lezer-extensions/index.js';

/**
 * Notes de bas de page manuelles pour l'export Word.
 *
 * Deux bugs motivent ce module (plan chapitres §1.2) :
 *
 * 1. `word-export` convertissait TOUS les marqueurs `[^N]` en placeholders
 *    `{{FN:N}}`, y compris les notes écrites par l'auteur, alors que la
 *    table des notes docx n'était peuplée qu'avec celles produites par le
 *    moteur de citation : une note manuelle pointait donc vers la note
 *    d'une citation, ou vers rien. Les lignes de définition `[^1]: …`
 *    étaient elles aussi frappées et restaient dans le corps du texte.
 * 2. Hors pipeline moteur, `marked` n'a aucune extension de notes : les
 *    `[^1]` sortaient en texte littéral dans le .docx.
 *
 * La détection passe par l'arbre Lezer : un `[^99]` dans un bloc de code
 * n'est pas une note et reste intact. La réécriture aussi, aux positions
 * (S12-1-16) : définitions prises par `collectFootnoteDefinitions`, appels
 * hors code (`footnoteCalls`). Une regex globale changeait les appels
 * jusque dans le code, et le retrait ligne à ligne ôtait une ligne
 * `[^1]: …` d'un bloc de code, dont le texte écrasait la vraie note.
 */

export interface ManualFootnote {
  /** Étiquette d'origine (`1`, `lester-danzig`). */
  label: string;
  /** Identifiant numérique attribué dans le document docx. */
  id: number;
  /** Texte de la définition, markdown brut, ses paragraphes séparés par `\n\n`. */
  text: string;
}

export interface ExtractedFootnotes {
  /** Markdown sans les blocs de définition, appels remplacés par `{{FN:id}}`. */
  markdown: string;
  footnotes: ManualFootnote[];
}

const literalParser = markdownParser.configure([GFM, Footnotes, PandocCitations]);

/** Là où un `[^…]` n'est pas un appel : code (bloc ou extrait) et crochet échappé. */
const LITERAL_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'Escape']);

/**
 * Appels de notes `[^label]` dont l'étiquette est retenue, positions du marqueur entier, ordre du
 * document : hors code et hors crochet échappé, d'après l'arbre Lezer. Les nœuds d'appel de
 * l'arbre ne suffisent pas : Lezer lit `![^1]` comme un début d'image, pandoc comme « ! » suivi
 * d'un appel (mesuré, pandoc 3.13). Avec eux seuls, l'appel posé après un point d'exclamation, à
 * la française, sortirait en clair.
 */
function footnoteCalls(
  markdown: string,
  wanted: (label: string) => boolean
): Array<{ label: string; from: number; to: number }> {
  const literal: Array<{ from: number; to: number }> = [];
  literalParser.parse(markdown).iterate({
    enter: (node) => {
      if (!LITERAL_NODES.has(node.name)) return;
      literal.push({ from: node.from, to: node.to });
      return false;
    },
  });
  const calls: Array<{ label: string; from: number; to: number }> = [];
  for (const m of markdown.matchAll(/\[\^([^\]\s[]+)\]/g)) {
    const from = m.index;
    if (!wanted(m[1]) || literal.some((r) => from >= r.from && from < r.to)) continue;
    calls.push({ label: m[1], from, to: from + m[0].length });
  }
  return calls;
}

/**
 * Texte d'une note : le corps de sa définition, retrait de continuation ôté. Ses paragraphes
 * restent séparés par une ligne vide (S12-2-6 : ils étaient joints par une espace, en un seul) ;
 * les lignes d'un même paragraphe se joignent par une espace.
 */
function noteText(body: string): string {
  return body
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph !== '')
    .join('\n\n');
}

/**
 * Extrait les notes manuelles d'un markdown : retire leurs définitions du
 * corps, remplace les appels par `{{FN:id}}`, et rend la table des notes.
 *
 * `reservedIds` contient les identifiants déjà pris par le moteur de
 * citation, pour que les deux familles cohabitent sans collision.
 */
export function extractManualFootnotes(
  markdown: string,
  reservedIds: number[] = []
): ExtractedFootnotes {
  const definitions = collectFootnoteDefinitions(markdown);
  if (definitions.length === 0) return { markdown, footnotes: [] };

  // La dernière définition d'une étiquette l'emporte, comme chez pandoc.
  const texts = new Map<string, string>();
  for (const def of definitions) texts.set(def.label, noteText(markdown.slice(def.bodyFrom, def.to)));

  // Seuls les appels hors définition deviennent des notes : celui qu'une
  // note contient reste dans son texte, qui part avec elle.
  const inDefinition = (pos: number): boolean => definitions.some((d) => pos >= d.from && pos < d.to);
  const calls = footnoteCalls(markdown, (label) => texts.has(label)).filter((c) => !inDefinition(c.from));

  // Attribution des identifiants docx : on préfère l'étiquette numérique de
  // l'auteur (le lecteur retrouve ses numéros) et on complète pour les
  // étiquettes libres, sans jamais heurter celles du moteur.
  const used = new Set<number>(reservedIds);
  const footnotes: ManualFootnote[] = [];
  let next = 1;
  const takeId = (label: string): number => {
    if (/^\d+$/.test(label)) {
      const wanted = parseInt(label, 10);
      if (wanted > 0 && !used.has(wanted)) {
        used.add(wanted);
        return wanted;
      }
    }
    while (used.has(next)) next++;
    used.add(next);
    return next;
  };

  const idByLabel = new Map<string, number>();
  // Ordre d'apparition des APPELS : c'est l'ordre de lecture.
  for (const call of calls) {
    if (!idByLabel.has(call.label)) idByLabel.set(call.label, takeId(call.label));
  }
  // Définitions jamais appelées : elles gardent une place, sans appel.
  for (const label of texts.keys()) {
    if (!idByLabel.has(label)) idByLabel.set(label, takeId(label));
  }

  for (const [label, id] of idByLabel) {
    footnotes.push({ label, id, text: texts.get(label) ?? '' });
  }
  footnotes.sort((a, b) => a.id - b.id);

  // Définitions retirées, appels remplacés, de la fin vers le début : les
  // positions restent valides.
  const edits = [
    ...definitions.map((d) => ({ from: d.from, to: d.to, insert: '' })),
    ...calls.map((c) => ({ from: c.from, to: c.to, insert: `{{FN:${idByLabel.get(c.label)}}}` })),
  ].sort((a, b) => b.from - a.from);
  let body = markdown;
  for (const edit of edits) body = body.slice(0, edit.from) + edit.insert + body.slice(edit.to);

  return { markdown: body, footnotes };
}

/**
 * Appels de notes produits par le moteur de citations (`[^n]`, n dans `numbers`) → `{{FN:n}}`,
 * hors code. Une regex globale frappait aussi un `[^n]` de bloc ou d'extrait de code, que la
 * numérotation des notes ne compte pas : le moteur avait pu produire une note n.
 */
export function placeEngineFootnoteCalls(markdown: string, numbers: number[]): string {
  const wanted = new Set(numbers.map(String));
  const calls = footnoteCalls(markdown, (label) => wanted.has(label));
  let out = markdown;
  for (let i = calls.length - 1; i >= 0; i--) {
    out = out.slice(0, calls[i].from) + `{{FN:${calls[i].label}}}` + out.slice(calls[i].to);
  }
  return out;
}
