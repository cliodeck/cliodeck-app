import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { CitationCandidate, ScholarlyLabels } from './types';
import { changeOrigin } from '../change-origin';

/**
 * Autocomplétion des citations (Phase 3b) : déclenchée par `@` précédé de
 * `[` ou d'une frontière de mot — détection par regex sur le texte avant le
 * curseur, PAS sur l'arbre (le nœud de citation nue n'existe qu'après un
 * premier caractère de clé). Filtrage identique au composant partagé
 * CitationAutocomplete : préfixe d'id d'abord, puis sous-chaîne sur
 * id / auteur / titre / année.
 */

const TRIGGER = /(^|[\s([;>])@([A-Za-z0-9_:-]*)$/;
const MAX_RESULTS = 12;

interface CompletionOptions {
  getCitations?: () => CitationCandidate[];
  labels: ScholarlyLabels;
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
    // `[@` ouvert et pas encore fermé → on ferme le crochet.
    const openedByBracket = view.state.sliceDoc(from - 2, from - 1) === '[';
    const alreadyClosed = view.state.sliceDoc(to, to + 1) === ']';
    const insert = candidate.id + (openedByBracket && !alreadyClosed ? ']' : '');
    view.dispatch({
      changes: { from, to, insert },
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

    const candidates = options.getCitations?.() ?? [];
    if (candidates.length === 0) {
      return {
        from,
        to: ctx.pos,
        options: [
          {
            label: options.labels.bibliographyEmpty,
            apply: () => {
              /* informative, non insérable */
            },
          },
        ],
        filter: false,
      };
    }

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
