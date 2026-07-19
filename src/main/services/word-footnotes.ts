import { collectFootnotes } from '../../editor/footnote-tools.js';

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
 * La détection passe par l'arbre Lezer (`collectFootnotes`) : un `[^99]`
 * dans un bloc de code n'est pas une note et reste intact.
 */

export interface ManualFootnote {
  /** Étiquette d'origine (`1`, `lester-danzig`). */
  label: string;
  /** Identifiant numérique attribué dans le document docx. */
  id: number;
  /** Texte de la définition, markdown brut. */
  text: string;
}

export interface ExtractedFootnotes {
  /** Markdown sans les blocs de définition, appels remplacés par `{{FN:id}}`. */
  markdown: string;
  footnotes: ManualFootnote[];
}

/** Début d'un bloc de définition `[^label]: …` en tête de ligne. */
const DEFINITION_LINE = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/;

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
  const occurrences = collectFootnotes(markdown);
  if (occurrences.length === 0) return { markdown, footnotes: [] };

  const definedLabels = new Set(
    occurrences.filter((o) => o.kind === 'definition').map((o) => o.label)
  );
  if (definedLabels.size === 0) return { markdown, footnotes: [] };

  // Les définitions vivent en tête de ligne : on les retire ligne à ligne,
  // en emportant leurs lignes de continuation indentées.
  const lines = markdown.split('\n');
  const bodyLines: string[] = [];
  const texts = new Map<string, string[]>();
  let current: string | null = null;

  for (const line of lines) {
    const m = line.match(DEFINITION_LINE);
    if (m && definedLabels.has(m[1])) {
      current = m[1];
      texts.set(current, [m[2] ?? '']);
      continue;
    }
    if (current !== null) {
      // Continuation : ligne indentée, ou ligne vide suivie d'une indentation.
      if (/^\s+\S/.test(line)) {
        texts.get(current)!.push(line.trim());
        continue;
      }
      if (line.trim() === '') {
        // Une ligne vide ne clôt pas forcément la note ; on la garde en
        // attente et la prochaine ligne tranche.
        texts.get(current)!.push('');
        continue;
      }
      current = null;
    }
    bodyLines.push(line);
  }

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
  for (const occ of occurrences) {
    if (occ.kind !== 'reference' || !definedLabels.has(occ.label)) continue;
    if (idByLabel.has(occ.label)) continue;
    idByLabel.set(occ.label, takeId(occ.label));
  }
  // Définitions jamais appelées : elles gardent une place, sans appel.
  for (const label of definedLabels) {
    if (!idByLabel.has(label)) idByLabel.set(label, takeId(label));
  }

  for (const [label, id] of idByLabel) {
    const text = (texts.get(label) ?? []).join(' ').replace(/\s+/g, ' ').trim();
    footnotes.push({ label, id, text });
  }
  footnotes.sort((a, b) => a.id - b.id);

  // Remplacement des appels dans le corps restant.
  let body = bodyLines.join('\n');
  for (const [label, id] of idByLabel) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    body = body.replace(new RegExp(`\\[\\^${escaped}\\]`, 'g'), `{{FN:${id}}}`);
  }

  return { markdown: body, footnotes };
}
