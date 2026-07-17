import { GFM, parser as baseParser } from '@lezer/markdown';
import { scholarlyMarkdown } from '../index';

export const parser = baseParser.configure([GFM, scholarlyMarkdown]);

export interface NodeInfo {
  name: string;
  from: number;
  to: number;
  text: string;
}

/** Parse `doc` and collect every node (optionally filtered by name). */
export function nodes(doc: string, name?: string): NodeInfo[] {
  const tree = parser.parse(doc);
  const out: NodeInfo[] = [];
  tree.iterate({
    enter(n) {
      if (!name || n.name === name) {
        out.push({ name: n.name, from: n.from, to: n.to, text: doc.slice(n.from, n.to) });
      }
    },
  });
  return out;
}

/** Shorthand: the texts of every node named `name`. */
export function texts(doc: string, name: string): string[] {
  return nodes(doc, name).map((n) => n.text);
}
