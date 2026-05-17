import { CitationEngine, type CSLItem } from '../../../backend/core/citation/CitationEngine.js';
import { citationToCSL } from '../../../backend/core/citation/citationFromZotero.js';
import type { Citation } from '../../../backend/types/citation.js';

/**
 * Options for {@link processMarkdownCitations}.
 */
export interface CitationPipelineOptions {
  style?: string;
  locale?: string;
  /**
   * Resolver: bibKey -> Citation | undefined. Typically wraps
   * `bibliographyService.getByCitationKey`. Passed in (rather than
   * imported) so tests don't need a live bibliography.
   */
  resolve: (key: string) => Citation | undefined;
  /** Optional pre-built engine for reuse / custom resources root. */
  engine?: CitationEngine;
}

export interface ProcessedFootnote {
  n: number;
  /** Rendered note text as returned by citeproc (HTML-ish). */
  text: string;
  /** The citation keys that produced this footnote (in cluster order). */
  keys: string[];
}

export interface ProcessedCitations {
  /** Markdown with `[@key]` markers replaced by `[^N]` (Pandoc footnote syntax). */
  md: string;
  footnotes: ProcessedFootnote[];
  /** Rendered bibliography entries, one string per reference. */
  bibliography: string[];
  /** Keys that could not be resolved — marker is left as-is. */
  missingKeys: string[];
}

/**
 * Matches a (possibly multi-key) citation cluster:
 *   [@alice2020]
 *   [@alice2020; @bob2021]
 * Key charset follows BibTeX convention (alnum, `_`, `:`, `-`).
 */
const CLUSTER_RE = /\[@([A-Za-z0-9_:-]+(?:\s*;\s*@[A-Za-z0-9_:-]+)*)\]/g;

/**
 * Scan markdown for `[@key]` / `[@a; @b]` clusters, render them via
 * citeproc-js, and return footnote-annotated markdown plus the rendered
 * footnotes and bibliography. Unknown keys leave the marker intact and
 * are reported in `missingKeys`.
 */
export async function processMarkdownCitations(
  markdown: string,
  opts: CitationPipelineOptions
): Promise<ProcessedCitations> {
  const style = opts.style ?? 'chicago-note-bibliography';
  const locale = opts.locale ?? 'fr-FR';
  const engine = opts.engine ?? new CitationEngine();

  const footnotes: ProcessedFootnote[] = [];
  const missingKeys: string[] = [];
  const bibItems: CSLItem[] = [];
  const bibSeen = new Set<string>();

  // First pass — collect all clusters, resolve keys, emit footnotes.
  interface Cluster {
    match: string;
    keys: string[];
    items: CSLItem[];
    n: number; // 0 if skipped (unresolved)
  }
  const clusters: Cluster[] = [];

  for (const m of markdown.matchAll(CLUSTER_RE)) {
    const rawKeys = m[1].split(/\s*;\s*/).map((k) => k.replace(/^@/, '').trim()).filter(Boolean);
    const items: CSLItem[] = [];
    const resolvedKeys: string[] = [];
    let anyMissing = false;
    for (const k of rawKeys) {
      const c = opts.resolve(k);
      if (!c) {
        anyMissing = true;
        missingKeys.push(k);
        continue;
      }
      items.push(citationToCSL(c));
      resolvedKeys.push(k);
    }
    if (anyMissing || items.length === 0) {
      clusters.push({ match: m[0], keys: rawKeys, items: [], n: 0 });
      continue;
    }
    clusters.push({ match: m[0], keys: resolvedKeys, items, n: footnotes.length + 1 });
    // Render this cluster as a single footnote.
    try {
      const res = engine.formatCitation(items, style, locale);
      // formatCitation produces one footnote per item in the current
      // implementation; join them with '; ' to emulate a cluster.
      const text = res.footnotes.join('; ');
      footnotes.push({ n: footnotes.length + 1, text, keys: resolvedKeys });
      for (const it of items) {
        const id = String(it.id);
        if (!bibSeen.has(id)) {
          bibSeen.add(id);
          bibItems.push(it);
        }
      }
    } catch (err) {
      // On rendering failure, treat as missing so caller sees the marker.
      clusters[clusters.length - 1] = { match: m[0], keys: rawKeys, items: [], n: 0 };
      for (const k of rawKeys) missingKeys.push(k);
    }
  }

  // Second pass — splice markers into markdown. Build output by scanning
  // with the same regex to keep offsets stable.
  let out = '';
  let lastIdx = 0;
  let clusterIdx = 0;
  for (const m of markdown.matchAll(CLUSTER_RE)) {
    const start = m.index ?? 0;
    out += markdown.slice(lastIdx, start);
    const cluster = clusters[clusterIdx++];
    if (cluster.n > 0) {
      out += `[^${cluster.n}]`;
    } else {
      // Unresolved — keep original marker verbatim.
      out += cluster.match;
    }
    lastIdx = start + m[0].length;
  }
  out += markdown.slice(lastIdx);

  // Render a consolidated bibliography for all unique items seen.
  let bibliography: string[] = [];
  if (bibItems.length > 0) {
    try {
      const res = engine.formatCitation(bibItems, style, locale);
      bibliography = res.bibliography;
    } catch {
      bibliography = [];
    }
  }

  return { md: out, footnotes, bibliography, missingKeys };
}
