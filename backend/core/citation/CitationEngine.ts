import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const CSL = require('citeproc');

/**
 * CSL-JSON item shape used by citeproc-js.
 * See https://citeproc-js.readthedocs.io/en/latest/csl-json/markup.html
 */
export interface CSLItem {
  id: string;
  type: string; // 'book' | 'article-journal' | 'chapter' | ...
  title?: string;
  author?: Array<{ family?: string; given?: string; literal?: string }>;
  editor?: Array<{ family?: string; given?: string; literal?: string }>;
  issued?: { 'date-parts'?: number[][]; literal?: string; raw?: string };
  'container-title'?: string;
  publisher?: string;
  'publisher-place'?: string;
  page?: string;
  volume?: string;
  issue?: string;
  URL?: string;
  DOI?: string;
  ISBN?: string;
  [k: string]: unknown;
}

export interface FormatResult {
  footnotes: string[];
  bibliography: string[];
}

type Locale = string;
type StyleId = string; // filename without .csl

/**
 * CitationEngine — minimal wrapper around citeproc-js.
 *
 * Loads CSL styles from `resources/csl/` and locales (`locales-xx-XX.xml`)
 * from the same folder. Exposes {@link formatCitation} which renders both
 * the in-text citation / footnote and the bibliography entries.
 *
 * Usage:
 *   const engine = new CitationEngine();
 *   const res = engine.formatCitation(items, 'chicago-note-bibliography', 'en-US');
 *
 * Thread-safety: not thread-safe. Instantiate once per render pass.
 */
export class CitationEngine {
  private readonly resourcesRoot: string;
  private styleCache = new Map<StyleId, string>();
  private localeCache = new Map<Locale, string>();

  constructor(resourcesRoot?: string) {
    this.resourcesRoot =
      resourcesRoot ?? path.resolve(__dirname, '..', '..', '..', 'resources', 'csl');
  }

  /** List available styles (files ending in .csl). */
  listStyles(): string[] {
    if (!fs.existsSync(this.resourcesRoot)) return [];
    return fs
      .readdirSync(this.resourcesRoot)
      .filter((f) => f.endsWith('.csl'))
      .map((f) => f.slice(0, -'.csl'.length));
  }

  /**
   * Format a list of CSL items into footnotes + bibliography for a given style/locale.
   *
   * @param items   CSL-JSON items (see {@link CSLItem})
   * @param styleId CSL style filename without extension, e.g. 'chicago-note-bibliography'
   * @param locale  BCP47-like locale, e.g. 'en-US' or 'fr-FR'
   */
  formatCitation(items: CSLItem[], styleId: StyleId, locale: Locale = 'en-US'): FormatResult {
    if (items.length === 0) {
      return { footnotes: [], bibliography: [] };
    }

    const styleXml = this.loadStyle(styleId);
    const itemsById = new Map<string, CSLItem>();
    for (const it of items) itemsById.set(String(it.id), it);

    const sys = {
      retrieveLocale: (lang: string) => this.loadLocale(this.normalizeLocale(lang)),
      retrieveItem: (id: string | number) => {
        const it = itemsById.get(String(id));
        if (!it) throw new Error(`CitationEngine: unknown CSL item id "${id}"`);
        return it;
      },
    };

    const engine = new CSL.Engine(sys, styleXml, locale);
    engine.updateItems(items.map((i) => String(i.id)));

    // Build one citation cluster per item (common case: one [@key] per note).
    const footnotes: string[] = items.map((it) => {
      const cluster = {
        citationItems: [{ id: String(it.id) }],
        properties: { noteIndex: 1 },
      };
      const result = engine.makeCitationCluster(cluster.citationItems);
      return typeof result === 'string' ? result : String(result);
    });

    const bib = engine.makeBibliography();
    // bib is [meta, entries] or false if style has no bibliography section.
    const bibliography: string[] =
      Array.isArray(bib) && Array.isArray(bib[1]) ? bib[1].map((e: string) => e.trim()) : [];

    return { footnotes, bibliography };
  }

  private loadStyle(styleId: StyleId): string {
    const cached = this.styleCache.get(styleId);
    if (cached) return cached;
    const p = path.join(this.resourcesRoot, `${styleId}.csl`);
    if (!fs.existsSync(p)) {
      throw new Error(`CitationEngine: style "${styleId}" not found at ${p}`);
    }
    const xml = fs.readFileSync(p, 'utf-8');
    this.styleCache.set(styleId, xml);
    return xml;
  }

  private loadLocale(locale: Locale): string {
    const cached = this.localeCache.get(locale);
    if (cached) return cached;
    const p = path.join(this.resourcesRoot, `locales-${locale}.xml`);
    if (!fs.existsSync(p)) {
      // Fall back to en-US so citeproc doesn't crash on exotic locales.
      if (locale !== 'en-US') return this.loadLocale('en-US');
      throw new Error(`CitationEngine: locale file missing at ${p}`);
    }
    const xml = fs.readFileSync(p, 'utf-8');
    this.localeCache.set(locale, xml);
    return xml;
  }

  private normalizeLocale(lang: string): Locale {
    if (lang?.toLowerCase().startsWith('fr')) return 'fr-FR';
    return 'en-US';
  }
}
