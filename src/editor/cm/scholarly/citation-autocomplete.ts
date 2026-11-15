import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { CitationCandidate } from './types';
import { changeOrigin } from '../change-origin';

/**
 * Autocomplétion des citations (Phase 3b) : déclenchée par `@` (ou `-@`,
 * auteur supprimé) précédé de `[` ou d'une frontière de mot — détection par
 * regex sur le texte avant le curseur, PAS sur l'arbre (le nœud de citation
 * nue n'existe qu'après un premier caractère de clé). Filtrage identique au
 * composant partagé CitationAutocomplete : préfixe d'id d'abord, puis
 * sous-chaîne sur id / auteur / titre / année.
 */

const TRIGGER = /(^|[\s([;>])-?@([A-Za-z0-9_:-]*)$/;
/** Les caractères de clé qui suivent le curseur : la fin de la clé remplacée. */
const KEY_TAIL = /^[A-Za-z0-9_:-]*/;
const MAX_RESULTS = 12;

interface CompletionOptions {
  getCitations?: () => CitationCandidate[];
}

function rank(
  candidates: CitationCandidate[],
  query: string
): CitationCandidate[] {
  const q = query.trim().toLowerCase();
  if (q === '') return candidates.slice(0, MAX_RESULTS);
  const starts: CitationCandidate[] = [];
  const contains: CitationCandidate[] = [];
  for (const c of candidates) {
    const id = c.id.toLowerCase();
    if (id.startsWith(q)) starts.push(c);
    else if (
      id.includes(q) ||
      c.author.toLowerCase().includes(q) ||
      c.title.toLowerCase().includes(q) ||
      c.year.includes(q)
    ) {
      contains.push(c);
    }
  }
  return [...starts, ...contains].slice(0, MAX_RESULTS);
}

function applyCitation(candidate: CitationCandidate) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    // La clé entière est remplacée, pas seulement sa partie avant le curseur (S14-2-1).
    const line = view.state.doc.lineAt(from);
    const end = to + (KEY_TAIL.exec(view.state.sliceDoc(to, line.to))?.[0].length ?? 0);
    // Un crochet ouvert et pas encore fermé sur la ligne → on le ferme. Ouvert : le dernier `[`
    // avant la clé n'est suivi d'aucun `]`. Fermé : un `]` vient après la clé avant tout `[`.
    const before = view.state.sliceDoc(line.from, from);
    const opened = before.lastIndexOf('[') > before.lastIndexOf(']');
    const after = view.state.sliceDoc(end, line.to);
    const close = after.indexOf(']');
    const reopen = after.indexOf('[');
    const alreadyClosed = close >= 0 && (reopen < 0 || close < reopen);
    const insert = candidate.id + (opened && !alreadyClosed ? ']' : '');
    view.dispatch({
      changes: { from, to: end, insert },
      selection: { anchor: from + insert.length },
      annotations: changeOrigin.of('programmatic'),
    });
  };
}

export function citationCompletion(options: CompletionOptions): Extension {
  const source = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = ctx.state.sliceDoc(line.from, ctx.pos);
    const match = TRIGGER.exec(before);
    if (!match) return null;
    const query = match[2];
    const from = ctx.pos - query.length; // juste après le `@`

    // Bibliographie vide : pas de liste. Une entrée informative prenait la touche Entrée
    // (S14-2-5) ; le soulignement « clé introuvable » et « Vérifier les citations » restent.
    const candidates = options.getCitations?.() ?? [];
    if (candidates.length === 0) return null;

    const completions: Completion[] = rank(candidates, query).map((c) => ({
      label: `@${c.id}`,
      detail: `${c.author} (${c.year})`,
      info: c.title,
      apply: applyCitation(c),
    }));
    return { from, to: ctx.pos, options: completions, filter: false };
  };

  return autocompletion({
    override: [source],
    icons: false,
    activateOnTyping: true,
  });
}
