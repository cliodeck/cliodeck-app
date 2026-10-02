import { CitationEngine, type CSLItem } from '../../../backend/core/citation/CitationEngine.js';
import { citationToCSL } from '../../../backend/core/citation/citationFromZotero.js';
import type { Citation } from '../../../backend/types/citation.js';
import { nextFootnoteNumber } from '../../editor/footnote-tools.js';

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
  /**
   * Markdown with citation markers replaced: by `[^N]` (Pandoc footnote
   * syntax) in the body under a note style, by the rendered citation itself
   * inside an author's footnote or under an in-text style.
   */
  md: string;
  footnotes: ProcessedFootnote[];
  /** Rendered bibliography entries, one string per reference. */
  bibliography: string[];
  /** Keys that could not be resolved — marker is left as-is. Deduplicated. */
  missingKeys: string[];
}

const KEY = '[A-Za-z0-9_](?:[A-Za-z0-9_:-]*[A-Za-z0-9_])?';

/**
 * Two shapes, in one pass so they cannot overlap:
 *   1. a bracketed cluster — `[@alice2020]`, `[@a; @b]`, and pandoc's
 *      affixes `[see @alice2020, p. 12]` — not followed by `(` (a link whose
 *      text holds an `@`), with the blanks before it, which a note call drops;
 *   2. a bare narrative key — `@alice2020` — not glued to a word, so an
 *      e-mail address is not a citation.
 * Key charset follows BibTeX convention (alnum, `_`, `:`, `-`).
 */
const CITATION_RE = new RegExp(
  `([ \\t]*)\\[([^\\[\\]\\n]*@[A-Za-z0-9_][^\\[\\]\\n]*)\\](?!\\()|(?<![\\w@\\\\])@(${KEY})`,
  'g'
);

/** One `;`-separated member of a cluster: optional prefix, key, optional suffix. */
const CLUSTER_PART_RE = new RegExp(`^(?:(.*?)\\s)?-?@(${KEY})(.*)$`);

/** Début d'un bloc de définition `[^label]: …` en tête de ligne. */
const NOTE_DEFINITION_RE = /^\[\^[^\]\s]+\]:/;
const FENCE_RE = /^\s*(```|~~~)/;

interface ClusterPart {
  prefix: string;
  key: string;
  suffix: string;
}

function parseCluster(inner: string): ClusterPart[] | null {
  const parts: ClusterPart[] = [];
  for (const raw of inner.split(';')) {
    const m = raw.trim().match(CLUSTER_PART_RE);
    if (!m) return null;
    parts.push({
      prefix: (m[1] ?? '').trim(),
      key: m[2],
      suffix: m[3].replace(/^\s*,?\s*/, '').trim(),
    });
  }
  return parts.length > 0 ? parts : null;
}

/**
 * citeproc rend du HTML (`<i>Titre</i>`, entités). Quand la citation est
 * recopiée DANS le markdown (note de l'auteur, style auteur-date), elle doit
 * redevenir du markdown, sinon l'italique des titres est perdu en route.
 */
export function cslHtmlToMarkdown(html: string): string {
  return html
    .replace(/<\/?(?:i|em)>/g, '*')
    .replace(/<\/?(?:b|strong)>/g, '**')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nom d'auteur pour une citation narrative (« Farge[^1] »). */
function narrativeName(item: CSLItem, locale: string): string {
  const names = (item.author?.length ? item.author : item.editor ?? [])
    .map((a) => a.family ?? a.literal ?? '')
    .filter(Boolean);
  if (names.length === 0) return item['title-short'] ?? item.title ?? String(item.id);
  if (names.length === 1) return names[0];
  if (names.length === 2) {
    return `${names[0]} ${locale.toLowerCase().startsWith('fr') ? 'et' : 'and'} ${names[1]}`;
  }
  return `${names[0]} et al.`;
}

/**
 * Scan markdown for citations — `[@key]`, `[@a; @b]`, `[see @key, p. 12]`
 * and bare `@key` — render them via citeproc-js, and return the rewritten
 * markdown plus the rendered footnotes and bibliography.
 *
 * Where the rendered citation goes depends on where the marker stands:
 *   - in the body, under a note style: a numbered footnote `[^N]` (a bare
 *     `@key` keeps the author's name in the sentence: `Farge[^N]`);
 *   - inside one of the author's own footnotes: in place — a note cannot
 *     hold a note, and `[^N]` there came out as literal text;
 *   - under an in-text style (MLA, APA): in place everywhere.
 *
 * Unknown keys leave the marker intact and are reported in `missingKeys`
 * (bracketed markers only: an unknown bare `@name` is more likely a handle
 * than a citation). Code blocks and code spans are left alone.
 */
export async function processMarkdownCitations(
  markdown: string,
  opts: CitationPipelineOptions
): Promise<ProcessedCitations> {
  const style = opts.style ?? 'chicago-note-bibliography';
  const locale = opts.locale ?? 'fr-FR';
  const engine = opts.engine ?? new CitationEngine();

  const footnotes: ProcessedFootnote[] = [];
  const missingKeys = new Set<string>();
  const bibItems: CSLItem[] = [];
  const bibSeen = new Set<string>();

  // Les notes générées démarrent APRÈS les notes déjà écrites par l'auteur.
  // Sans cela, un `[^1]` manuel et la première citation portaient le même
  // numéro : deux appels, une seule définition, et le texte de l'auteur
  // disparaissait du document exporté. La détection passe par l'arbre
  // Lezer, donc un `[^99]` dans un bloc de code ne décale rien.
  const firstNumber = nextFootnoteNumber(markdown);

  let noteStyle: boolean | null = null;
  const isNoteStyle = (): boolean => (noteStyle ??= engine.isNoteStyle(style));

  /** Rend un groupe ; `null` si une clé manque ou si le rendu échoue. */
  const render = (parts: ClusterPart[], report: boolean): { text: string; items: CSLItem[] } | null => {
    const items: CSLItem[] = [];
    for (const part of parts) {
      const c = opts.resolve(part.key);
      if (!c) {
        if (report) for (const p of parts) if (!opts.resolve(p.key)) missingKeys.add(p.key);
        return null;
      }
      items.push(citationToCSL(c));
    }
    let rendered: string[];
    try {
      // formatCitation produces one entry per item in the current
      // implementation; they are joined with '; ' to emulate a cluster.
      rendered = engine.formatCitation(items, style, locale).footnotes;
    } catch (err) {
      console.warn('⚠️ CitationEngine: rendering failed for', parts.map((p) => p.key), err);
      if (report) for (const p of parts) missingKeys.add(p.key);
      return null;
    }
    const text = rendered
      .map((r, i) => {
        const { prefix, suffix } = parts[i];
        if (!suffix) return prefix ? `${prefix} ${r}` : r;
        // « Farge, Le goût de l'archive. » + « p. 12 » : le point final
        // passe après le renvoi de page.
        const core = r.replace(/\.\s*$/, '');
        const closed = `${core}, ${suffix}`;
        return `${prefix ? `${prefix} ` : ''}${closed}${/[.!?]$/.test(closed) ? '' : '.'}`;
      })
      .join('; ');
    for (const it of items) {
      const id = String(it.id);
      if (!bibSeen.has(id)) {
        bibSeen.add(id);
        bibItems.push(it);
      }
    }
    return { text, items };
  };

  const rewrite = (segment: string, inNote: boolean): string =>
    segment.replace(
      CITATION_RE,
      (match: string, space: string | undefined, inner: string | undefined, bareKey: string | undefined) => {
        const parts =
          inner !== undefined ? parseCluster(inner) : [{ prefix: '', key: bareKey!, suffix: '' }];
        if (!parts) return match;
        const res = render(parts, inner !== undefined);
        if (!res) return match;

        if (inNote || !isNoteStyle()) {
          // En place : la phrase de l'auteur porte déjà sa ponctuation.
          return (space ?? '') + cslHtmlToMarkdown(res.text).replace(/\.$/, '');
        }
        const n = firstNumber + footnotes.length;
        footnotes.push({ n, text: res.text, keys: parts.map((p) => p.key) });
        // L'appel de note se colle au mot qui précède, comme le fait pandoc :
        // « Srnicek [@clé] » ne doit pas donner un appel isolé par une espace.
        return inner !== undefined ? `[^${n}]` : `${narrativeName(res.items[0], locale)}[^${n}]`;
      }
    );

  // Ligne à ligne : c'est la position de la ligne (définition de note, bloc
  // de code) qui décide du traitement, et un marqueur ne franchit jamais une
  // fin de ligne.
  let inNote = false;
  let inFence = false;
  const out = markdown.split('\n').map((line) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    if (NOTE_DEFINITION_RE.test(line)) inNote = true;
    else if (inNote && line.trim() !== '' && !/^\s+\S/.test(line)) inNote = false;
    if (!line.includes('@')) return line;
    // Les segments impairs sont des extraits de code en ligne.
    return line
      .split(/(`[^`]*`)/)
      .map((seg, i) => (i % 2 === 1 ? seg : rewrite(seg, inNote)))
      .join('');
  });

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

  return { md: out.join('\n'), footnotes, bibliography, missingKeys: [...missingKeys] };
}
