import type { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode, Tree } from '@lezer/common';

/**
 * Recherches dans l'arbre syntaxique pour les comportements de notes
 * (infobulle, popup, navigation). L'arbre incrémental peut être partiel :
 * on force un parse complet borné (300 ms) avant les recherches globales.
 */

export interface FootnoteHit {
  kind: 'reference' | 'definition';
  label: string;
  from: number;
  to: number;
}

export interface DefinitionRange {
  from: number;
  to: number;
  /** Corps de la note : après `]:` (+ un espace optionnel). */
  contentFrom: number;
  contentTo: number;
}

export function fullTree(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, 300) ?? syntaxTree(state);
}

function labelOf(state: EditorState, node: SyntaxNode): string | null {
  const label = node.getChild('FootnoteLabel');
  return label ? state.sliceDoc(label.from, label.to) : null;
}

/** La note (appel ou définition) contenant `pos`, sinon null. */
export function footnoteAt(state: EditorState, pos: number): FootnoteHit | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  if (node.from === node.to && pos > 0) {
    node = syntaxTree(state).resolveInner(pos, -1);
  }
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    if (n.name === 'FootnoteReference' || n.name === 'FootnoteDefinition') {
      // Pour une définition, ne réagir que sur son en-tête `[^id]:` — pas
      // sur tout le corps de la note.
      if (n.name === 'FootnoteDefinition') {
        const marks = n.getChildren('FootnoteMark');
        const headEnd = marks.length >= 2 ? marks[marks.length - 1].to : n.from;
        if (pos > headEnd) return null;
      }
      const label = labelOf(state, n);
      if (label === null) return null;
      return {
        kind: n.name === 'FootnoteReference' ? 'reference' : 'definition',
        label,
        from: n.from,
        to: n.to,
      };
    }
  }
  return null;
}

/** La définition `[^label]: …`, avec la plage exacte de son corps. */
export function findDefinition(
  state: EditorState,
  label: string
): DefinitionRange | null {
  let found: DefinitionRange | null = null;
  fullTree(state).iterate({
    enter: (node) => {
      if (found) return false;
      if (node.name !== 'FootnoteDefinition') return;
      if (labelOf(state, node.node) !== label) return;
      const marks = node.node.getChildren('FootnoteMark');
      const head = marks.length >= 2 ? marks[marks.length - 1].to : node.from;
      const contentFrom =
        state.sliceDoc(head, head + 1) === ' ' ? head + 1 : head;
      found = {
        from: node.from,
        to: node.to,
        contentFrom,
        contentTo: node.to,
      };
      return false;
    },
  });
  return found;
}

/** Le premier appel `[^label]` du document (navigation retour). */
export function findFirstReference(
  state: EditorState,
  label: string
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  fullTree(state).iterate({
    enter: (node) => {
      if (found) return false;
      if (node.name !== 'FootnoteReference') return;
      if (labelOf(state, node.node) !== label) return;
      found = { from: node.from, to: node.to };
      return false;
    },
  });
  return found;
}

/** Les clés du cluster de citation contenant `pos`, sinon null. */
export function citationAt(
  state: EditorState,
  pos: number
): { keys: string[]; from: number; to: number } | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    if (n.name === 'PandocCitation') {
      const keys = n
        .getChildren('CitationKey')
        .map((k) => state.sliceDoc(k.from, k.to));
      return keys.length ? { keys, from: n.from, to: n.to } : null;
    }
  }
  return null;
}
