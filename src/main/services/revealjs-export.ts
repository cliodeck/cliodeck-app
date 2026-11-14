import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import { join, dirname, resolve as resolvePath } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { app, BrowserWindow, net, shell } from 'electron';
import { load as loadYaml } from 'js-yaml';
import { marked } from 'marked';
import {
  parseSlides as parseDeck,
  splitSlideParts,
  startsWithH1,
  type DeckInfo,
} from '../../editor/slides.js';
import { refuseMarkdownOutput } from './export-output-path.js';
import {
  pathExists,
  withExportTimeLimit,
  type ExportClock,
  type ExportLimits,
  type ExportResult,
} from './export-time-limit.js';
import { atomicWriteFile } from '../../../backend/core/fs/user-files.js';
import type { OutcomeIssue } from '../../../backend/types/outcome.js';

// Rendu markdown des slides de la preview : même famille de grammaire que le
// plugin markdown de reveal.js (qui embarque marked) — la preview et l'export
// partagent désormais le découpage (parseDeck) ET la grammaire.
marked.setOptions({ gfm: true, breaks: false });

// MARK: - CDN Asset definitions for offline export

const REVEAL_VERSION = '5.0.4';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}`;

interface CdnAsset {
  url: string;
  tag: 'style' | 'script';
  /** attribute to add (e.g. 'id="highlight-theme"') */
  attrs?: string;
}

/** CSS assets (loaded in <head>) */
const getCssAssets = (theme: string): CdnAsset[] => [
  { url: `${CDN_BASE}/dist/reset.css`, tag: 'style' },
  { url: `${CDN_BASE}/dist/reveal.css`, tag: 'style' },
  { url: `${CDN_BASE}/dist/theme/${theme}.css`, tag: 'style', attrs: 'id="theme"' },
  { url: `${CDN_BASE}/plugin/highlight/monokai.css`, tag: 'style' },
];

/**
 * Le greffon des formules, qui charge KaTeX du réseau au rendu. Facultatif pour le PDF : sans lui,
 * les formules restent telles qu'écrites, et la réserve le dit.
 */
const MATH_ASSET: CdnAsset = { url: `${CDN_BASE}/plugin/math/math.js`, tag: 'script' };

/** JS assets (loaded at end of <body>, before init script) */
const getJsAssets = (options?: { includeMath?: boolean }): CdnAsset[] => {
  const assets: CdnAsset[] = [
    { url: `${CDN_BASE}/dist/reveal.js`, tag: 'script' },
    { url: `${CDN_BASE}/plugin/notes/notes.js`, tag: 'script' },
    { url: `${CDN_BASE}/plugin/markdown/markdown.js`, tag: 'script' },
    { url: `${CDN_BASE}/plugin/highlight/highlight.js`, tag: 'script' },
    { url: `${CDN_BASE}/plugin/zoom/zoom.js`, tag: 'script' },
    { url: `${CDN_BASE}/plugin/search/search.js`, tag: 'script' },
  ];
  if (options?.includeMath) assets.push(MATH_ASSET);
  return assets;
};

/** Les fichiers de reveal.js sans lesquels une page ne se rend pas : à inclure dans la page. */
const getAllCdnAssets = (theme: string): CdnAsset[] => [...getCssAssets(theme), ...getJsAssets()];

/**
 * Le deck a-t-il des formules (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) ? Lu sur le corps : le
 * frontmatter n'est pas du contenu.
 *
 * `$…$` suit la règle de pandoc, celle des exports PDF et Word : un `$` ouvrant (non échappé) suivi
 * d'un caractère non blanc, un `$` fermant précédé d'un caractère non blanc et non suivi d'un
 * chiffre. « De $200 à $300 » n'est pas une formule : le greffon, que ce test fait inclure, l'aurait
 * mise en forme comme telle, et l'export dit des formules non rendues (revue de L09-12).
 */
function deckUsesMath(body: string): boolean {
  return /\$\$.+?\$\$|(?<!\\)\$(?![\s$])[^$\n]*?(?<![\s\\])\$(?!\d)|\\\(.+?\\\)|\\\[.+?\\\]/s.test(body);
}

// MARK: - Feuilles de style autonomes (export PDF et HTML autonome)

/** Un fichier qu'une feuille de style demande (feuille importée, police), du cache ou du réseau. */
type ResourceLoader = (url: string) => Promise<Buffer>;

/** Les formats de police que Chromium lit, par indice `format()` ou par extension. */
const FONT_TYPES: Record<string, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  truetype: 'font/ttf',
  ttf: 'font/ttf',
  opentype: 'font/otf',
  otf: 'font/otf',
};

/** Les thèmes importent des feuilles de polices, qui n'importent rien : trois niveaux laissent de la marge. */
const MAX_IMPORT_DEPTH = 3;

const IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])([^'"]*)\3)\s*([^;]*);/g;
const FONT_FACE_RE = /@font-face\s*\{[^}]*\}/g;
const SRC_RE = /\bsrc\s*:\s*([^;}]*);?/g;
const FONT_ENTRY_RE = /^url\(\s*(['"]?)([^'")]*)\1\s*\)(?:\s*format\(\s*(['"]?)([^'")]*)\3\s*\))?$/i;

/** Remplace chaque correspondance de `re` par ce que rend `replace`, attendu. */
async function replaceAsync(
  text: string,
  re: RegExp,
  replace: (match: RegExpMatchArray) => Promise<string>
): Promise<string> {
  const matches = [...text.matchAll(re)];
  const replacements = await Promise.all(matches.map(replace));
  let out = '';
  let last = 0;
  matches.forEach((m, i) => {
    out += text.slice(last, m.index) + replacements[i];
    last = (m.index ?? 0) + m[0].length;
  });
  return out + text.slice(last);
}

/**
 * Une liste `src` de `@font-face` réduite à ce que Chromium lira : les `local()` et la première
 * forme qu'il sait lire (woff2, woff, TrueType, OpenType), incluse en `data:`. Les autres formes
 * (`.eot`, ou le `.ttf` qui suit un `.woff`) ne seraient jamais demandées : elles partent, ce qui
 * évite de télécharger et d'inclure trois fois chaque police. Une police introuvable laisse la
 * liste sans elle (police de repli), et son adresse va dans `missing`.
 */
async function selfContainedFontSource(
  declaration: RegExpMatchArray,
  cssUrl: string,
  load: ResourceLoader,
  missing: Set<string>
): Promise<string> {
  const entries = declaration[1].split(/,(?=\s*(?:url|local)\()/i).map((e) => e.trim());
  const locals = entries.filter((e) => /^local\(/i.test(e));
  const keep = (extra: string[]) => {
    const list = [...locals, ...extra];
    return list.length > 0 ? `src: ${list.join(', ')};` : '';
  };
  for (const entry of entries) {
    const m = FONT_ENTRY_RE.exec(entry);
    if (!m) continue;
    const [, , url, , format] = m;
    if (url.startsWith('data:')) return keep([entry]);
    const extension = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1] ?? '';
    const type = FONT_TYPES[(format || extension).toLowerCase()];
    if (!type) continue;
    const target = new URL(url, cssUrl).href;
    try {
      const bytes = await load(target);
      return keep([`url(data:${type};base64,${bytes.toString('base64')})${format ? ` format('${format}')` : ''}`]);
    } catch {
      missing.add(target);
      return keep([]);
    }
  }
  return keep([]);
}

/**
 * Une feuille de style sans rien à chercher au dehors : ses `@import` remplacés par la feuille
 * qu'ils désignent, résolue contre l'adresse de celle-ci (les thèmes de reveal.js importent leurs
 * polices par un chemin relatif à leur fichier du CDN, ou depuis Google Fonts), et ses polices
 * incluses en `data:`. Recopiée telle quelle dans la page, une feuille perdait ses polices : un
 * chemin relatif y vise le dossier de la page, et une page d'impression qui attend Google Fonts
 * attend sans borne sur un réseau qui ne répond pas (revue de L09-12). Ce qui n'a pu venir est
 * retiré, et son adresse notée dans `missing`.
 */
async function selfContainedCss(
  css: string,
  cssUrl: string,
  load: ResourceLoader,
  missing: Set<string>,
  depth = 0
): Promise<string> {
  const fonts = await replaceAsync(css, FONT_FACE_RE, async (face) =>
    replaceAsync(face[0], SRC_RE, (declaration) => selfContainedFontSource(declaration, cssUrl, load, missing))
  );
  return replaceAsync(fonts, IMPORT_RE, async (m) => {
    const target = new URL(m[2] ?? m[4] ?? '', cssUrl).href;
    const media = m[5].trim();
    try {
      if (depth >= MAX_IMPORT_DEPTH) throw new Error(`@import trop profond : ${target}`);
      const imported = await selfContainedCss((await load(target)).toString('utf-8'), target, load, missing, depth + 1);
      return media ? `@media ${media} {\n${imported}\n}` : imported;
    } catch {
      missing.add(target);
      return '';
    }
  });
}

// MARK: - Types

export interface RevealJsExportOptions {
  projectPath: string;
  content: string;
  outputPath?: string;
  metadata?: {
    title?: string;
    author?: string;
    date?: string;
  };
  config?: {
    theme?: 'black' | 'white' | 'league' | 'beige' | 'sky' | 'night' | 'serif' | 'simple' | 'solarized' | 'blood' | 'moon';
    transition?: 'none' | 'fade' | 'slide' | 'convex' | 'concave' | 'zoom';
    controls?: boolean;
    progress?: boolean;
    slideNumber?: boolean;
    history?: boolean;
    keyboard?: boolean;
    overview?: boolean;
    center?: boolean;
    touch?: boolean;
    loop?: boolean;
    rtl?: boolean;
    shuffle?: boolean;
    fragments?: boolean;
    embedded?: boolean;
    help?: boolean;
    showNotes?: boolean; // Mode présentateur avec notes
    autoSlide?: number; // 0 = disabled
    autoSlideStoppable?: boolean;
    mouseWheel?: boolean;
    hideAddressBar?: boolean;
    previewLinks?: boolean;
    transitionSpeed?: 'default' | 'fast' | 'slow';
    backgroundTransition?: 'none' | 'fade' | 'slide' | 'convex' | 'concave' | 'zoom';
    viewDistance?: number;
    parallaxBackgroundImage?: string;
    parallaxBackgroundSize?: string;
  };
}

interface RevealJsProgress {
  stage: 'preparing' | 'converting' | 'complete';
  message: string;
  progress: number;
}

// MARK: - Deck frontmatter (source de config reveal)

/**
 * Métadonnées lues depuis le frontmatter YAML de `slides.md`. Précédence :
 * frontmatter > `reveal-config.json` pour theme/transition ; pour le titre et
 * l'auteur, la saisie explicite du modal d'export garde la main, le
 * frontmatter comble les champs laissés vides. Un deck devient ainsi un
 * fichier autoportant.
 */
export interface DeckFrontmatterMeta {
  title?: string;
  author?: string;
  date?: string;
  theme?: string;
  transition?: string;
}

const VALID_THEMES = new Set([
  'black', 'white', 'league', 'beige', 'sky', 'night', 'serif', 'simple',
  'solarized', 'blood', 'moon',
]);
const VALID_TRANSITIONS = new Set([
  'none', 'fade', 'slide', 'convex', 'concave', 'zoom',
]);

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export interface ExtractedDeck {
  /** Contenu sans le frontmatter (pour les détections type usesMath). */
  body: string;
  meta: DeckFrontmatterMeta;
  /** Découpage partagé (src/editor/slides.ts) — offsets absolus. */
  deck: DeckInfo;
}

/**
 * Extraction unique frontmatter + découpage : la détection (règle
 * frontmatter vs séparateur en tête de deck, `---` de blocs de code ignorés)
 * vit dans src/editor/slides.ts — une seule vérité pour l'éditeur, le
 * navigateur, la preview et l'export.
 */
export function extractDeck(content: string): ExtractedDeck {
  const deck = parseDeck(content);
  let meta: DeckFrontmatterMeta = {};
  let body = content;
  if (deck.frontmatter) {
    body = content.slice(Math.min(deck.frontmatter.to + 1, content.length));
    try {
      const raw = loadYaml(deck.frontmatter.yaml);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const r = raw as Record<string, unknown>;
        meta = {
          title: pickString(r.title),
          author: pickString(r.author),
          date: pickString(r.date),
          theme: pickString(r.theme),
          transition: pickString(r.transition),
        };
        if (meta.theme && !VALID_THEMES.has(meta.theme)) meta.theme = undefined;
        if (meta.transition && !VALID_TRANSITIONS.has(meta.transition)) {
          meta.transition = undefined;
        }
      }
    } catch {
      // YAML invalide : on strippe quand même (ce n'est pas une slide),
      // mais aucune métadonnée n'est lue.
    }
  }
  return { body, meta, deck };
}

// MARK: - Slide parsing (shared between export & preview)

/**
 * Structure 2D reveal construite SUR le découpage partagé :
 *
 *  # Title        → new horizontal section (navigate left/right)
 *  ## Sub-title   → new vertical slide within the current section (navigate up/down)
 *  ---            → explicit slide separator (vertical within current section)
 *  Note: …        → speaker notes (everything after "Note:" until end of slide block)
 *
 * Les parties `##` et les notes viennent de `splitSlideParts` (src/editor/slides.ts) : rien
 * de ce qui est dans un bloc de code ne coupe ni n'ouvre de notes.
 *
 * `aIndex` rattache chaque slide reveal à l'index du découpage partagé
 * (SlideInfo.index) — c'est la clé de la synchro curseur ↔ preview. Les
 * sous-découpes `##` d'un segment H1 partagent l'aIndex de leur segment.
 */
interface ParsedSlide { markdown: string; notes: string; aIndex: number }
type SlideSection = ParsedSlide[];

function buildSections(content: string, deck: DeckInfo): SlideSection[] {
  const sections: SlideSection[] = [];
  let cur: ParsedSlide[] = [];

  for (const slide of deck.slides) {
    const segment = content.slice(slide.from, slide.to);
    const parts = splitSlideParts(segment);
    if (parts.length === 0) continue;

    if (startsWithH1(segment) && cur.length) {
      sections.push(cur);
      cur = [];
    }
    for (const part of parts) {
      cur.push({ markdown: part.markdown, notes: part.notes, aIndex: slide.index });
    }
  }
  if (cur.length) sections.push(cur);
  return sections;
}

// MARK: - Preview (lightweight, self-contained)

/**
 * Generates a lightweight, self-contained preview HTML.
 * No CDN dependencies — works reliably inside Electron iframe srcDoc.
 * Le markdown est rendu côté main par `marked` (même grammaire que le plugin
 * markdown de reveal, qui l'embarque) sur le découpage partagé — plus de
 * mini-moteur regex divergent. Le shell reste autonome (sandbox iframe
 * `allow-scripts` sans `allow-same-origin` inchangé côté renderer).
 */
export function generatePreviewHtml(
  content: string,
  _options: RevealJsExportOptions,
  activeSlideIndex = 0
): string {
  const { meta, deck } = extractDeck(content);
  const sections = buildSections(content, deck);
  const theme = meta.theme || _options.config?.theme || 'black';

  const renderMd = (md: string): string =>
    marked.parse(md, { async: false }) as string;

  // Flatten all slides with section/slide indices for the navigation label
  const flatSlides: { html: string; notesHtml: string; label: string; aIndex: number }[] = [];
  sections.forEach((sec, si) => {
    sec.forEach((slide, vi) => {
      const label = sec.length > 1 ? `${si + 1}.${vi + 1}` : `${si + 1}`;
      flatSlides.push({
        html: renderMd(slide.markdown),
        notesHtml: slide.notes ? renderMd(slide.notes) : '',
        label,
        aIndex: slide.aIndex,
      });
    });
  });

  if (!flatSlides.length) {
    flatSlides.push({ html: '<p><em>Aucun contenu</em></p>', notesHtml: '', label: '1', aIndex: 0 });
  }


  const isDark = !['white', 'beige', 'sky', 'serif', 'simple', 'solarized'].includes(theme);
  const bg = isDark ? '#191919' : '#f5f5f0';
  const fg = isDark ? '#eee' : '#222';
  const fgMuted = isDark ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.4)';
  const accent = isDark ? '#42affa' : '#2a76dd';
  const noteBg = isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.04)';

  // Slide affichée = celle du curseur (synchro faite CÔTÉ MAIN : la CSP de
  // l'app interdit tout script inline, y compris dans un iframe srcDoc —
  // la preview est donc entièrement statique et le panneau la régénère à
  // chaque déplacement de slide active).
  const activePos = Math.max(
    0,
    flatSlides.findIndex((s) => s.aIndex === activeSlideIndex)
  );
  const active = flatSlides[activePos];

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden;font-family:Source Sans Pro,Helvetica,sans-serif;
  background:${bg};color:${fg}}
.container{height:100%;display:flex;flex-direction:column}
.slides{flex:1;overflow-y:auto;padding:12px;scroll-behavior:smooth}
.slide{background:${isDark ? '#222' : '#fff'};border-radius:6px;padding:28px 32px;
  margin-bottom:10px;position:relative;min-height:80px;
  border:2px solid transparent;cursor:pointer;transition:border-color .15s}
.slide.active{border-color:${accent}}
.slide-num{position:absolute;top:6px;right:10px;font-size:11px;color:${fgMuted};font-variant-numeric:tabular-nums}
.slide-body{line-height:1.5}
.slide-body h1{font-size:1.5em;font-weight:600;margin:.3em 0}
.slide-body h2{font-size:1.25em;font-weight:600;margin:.3em 0}
.slide-body h3{font-size:1.1em;font-weight:600;margin:.3em 0}
.slide-body h4,.slide-body h5,.slide-body h6{font-size:1em;font-weight:600;margin:.2em 0}
.slide-body p{margin:.4em 0}
.slide-body ul,.slide-body ol{margin:.4em 0 .4em 1.4em}
.slide-body li{margin:.15em 0}
.slide-body code{font-family:monospace;background:${isDark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.06)'};
  padding:1px 5px;border-radius:3px;font-size:.9em}
.slide-body pre{background:${isDark ? '#111' : '#f0f0f0'};padding:10px 14px;border-radius:4px;
  overflow-x:auto;margin:.5em 0;font-size:.85em}
.slide-body pre code{background:none;padding:0}
.slide-body blockquote{border-left:3px solid ${accent};padding-left:12px;margin:.5em 0;
  color:${fgMuted};font-style:italic}
.slide-body a{color:${accent};text-decoration:none}
.slide-body img{max-width:100%;border-radius:4px;margin:.3em 0}
.slide-body table{border-collapse:collapse;margin:.5em 0;width:100%}
.slide-body th,.slide-body td{border:1px solid ${isDark ? '#555' : '#ccc'};padding:5px 10px;text-align:left}
.slide-body th{font-weight:600;background:${isDark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.04)'}}
.slide-body strong{font-weight:700}
.slide-body em{font-style:italic}
.slide-notes{margin-top:8px;padding:8px 12px;font-size:.8em;color:${fgMuted};
  background:${noteBg};border-radius:4px;border-left:3px solid ${accent}}
.slide-notes::before{content:'\\1F5D2  Note';display:block;font-size:.75em;font-weight:600;
  text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;opacity:.7}
.nav{display:flex;align-items:center;justify-content:center;gap:6px;
  padding:6px 10px;border-top:1px solid ${isDark ? '#333' : '#ddd'};flex-shrink:0}
.nav button{background:none;border:1px solid ${isDark ? '#555' : '#bbb'};color:${fg};
  border-radius:4px;padding:3px 12px;cursor:pointer;font-size:12px}
.nav button:hover{background:${isDark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.05)'}}
.nav span{font-size:12px;color:${fgMuted};min-width:50px;text-align:center}
</style></head><body>
<div class="container">
  <div class="slides">
    <div class="slide active" data-index="${activePos}" data-aslide="${active.aIndex}">
      <span class="slide-num">${active.label}</span>
      <div class="slide-body">${active.html}</div>
      ${active.notesHtml ? `<div class="slide-notes">${active.notesHtml}</div>` : ''}
    </div>
  </div>
  <div class="nav">
    <span>${activePos + 1} / ${flatSlides.length}</span>
  </div>
</div>
</body></html>`;
}

// MARK: - Reveal.js export templates

/**
 * Le plugin markdown de reveal.js redécoupe chaque section `data-markdown` dans le navigateur,
 * sans rien savoir des blocs de code : sur `---` (`data-separator`, défaut `\r?\n---\r?\n`),
 * puis sur `Note:` (`data-separator-notes`, défaut `notes?:` en tête de ligne), et ne tire des
 * notes que si ce second découpage rend deux morceaux. Un `---` ou un `Note:` cité dans du code
 * coupait donc la diapositive exportée ou en envoyait la suite aux notes, et deux `Note:` dans
 * une section faisaient afficher la vraie note sur la diapositive (S12-2-3). Le découpage est
 * déjà fait ici (`splitSlideParts`) : le séparateur posé sur chaque section ne correspond à
 * aucune ligne écrite, et les notes s'ouvrent par un repère que l'auteur n'écrit pas. Vérifié
 * sur la copie 5.0.4 que l'app met en cache : à revérifier si REVEAL_VERSION change (l'e2e
 * `journey-presentation-pdf.spec.ts` le couvre).
 */
const NO_SPLIT_SEPARATOR = '^CLIODECK-NO-SPLIT$';
const SPEAKER_NOTES_MARKER = 'CLIODECK-SPEAKER-NOTES';

/**
 * Résolution de la config effective d'un deck : frontmatter > reveal-config
 * pour theme/transition ; saisie du modal > frontmatter pour titre/auteur.
 * Exportée pour l'export offline (choix des assets) et les tests.
 */
export function resolveDeckConfig(
  content: string,
  options: RevealJsExportOptions
): { theme: string; transition: string; title: string; author: string } {
  const { meta } = extractDeck(content);
  return {
    theme: meta.theme || options.config?.theme || 'black',
    transition: meta.transition || options.config?.transition || 'slide',
    title: options.metadata?.title || meta.title || 'Présentation',
    author: options.metadata?.author || meta.author || '',
  };
}

/**
 * Les marques que pose la page d'impression (export PDF), et que lit la sonde du main
 * (`printLayoutProbe`) : reveal.js a fini de poser les pages (`pdf-ready`), KaTeX n'a pas pu se
 * charger.
 */
const PDF_READY_ATTR = 'data-cliodeck-pdf-ready';
const MATH_FAILED_ATTR = 'data-cliodeck-math-failed';

/**
 * Le HTML d'une présentation. `inlinedAssets` : les fichiers de reveal.js, inclus dans la page au
 * lieu d'être chargés du CDN (export hors ligne et PDF). `page.print` : la page que l'export PDF
 * imprime, en mode impression de reveal.js, avec les marques que lit la sonde. `page.math` : le
 * greffon des formules, par défaut quand le deck en a et que KaTeX peut venir du réseau (HTML en
 * ligne, PDF) ; l'export PDF le retire quand KaTeX fait attendre la page.
 */
const getRevealJsHTML = (
  content: string,
  options: RevealJsExportOptions,
  inlinedAssets?: Map<string, string>,
  page: { print?: boolean; math?: boolean } = {}
): string => {
  const print = page.print ?? false;
  const config = options.config || {};

  const { body, deck } = extractDeck(content);
  const resolved = resolveDeckConfig(content, options);
  const sections = buildSections(content, deck);

  // ── Build slides HTML ─────────────────────────────────────────────────
  // Les notes restent dans le <textarea>, derrière un repère que le plugin markdown de
  // reveal.js reconnaît par `data-separator-notes` (voir NO_SPLIT_SEPARATOR).

  const slideToHTML = (s: ParsedSlide): string => {
    const fullMd = s.notes ? `${s.markdown}\n\n${SPEAKER_NOTES_MARKER}\n${s.notes}` : s.markdown;
    return `          <section data-markdown data-separator="${NO_SPLIT_SEPARATOR}" data-separator-notes="^${SPEAKER_NOTES_MARKER}$">\n            <textarea data-template>\n${fullMd}\n            </textarea>\n          </section>`;
  };

  const slidesHTML = sections.map(section => {
    if (section.length === 1) {
      return slideToHTML(section[0]);
    }
    const inner = section.map(slideToHTML).join('\n');
    return `        <section>\n${inner}\n        </section>`;
  }).join('\n');

  // Build config object
  const revealConfig = {
    theme: resolved.theme,
    transition: resolved.transition,
    controls: config.controls !== false,
    progress: config.progress !== false,
    slideNumber: config.slideNumber || false,
    history: config.history !== false,
    keyboard: config.keyboard !== false,
    overview: config.overview !== false,
    center: config.center !== false,
    touch: config.touch !== false,
    loop: config.loop || false,
    rtl: config.rtl || false,
    shuffle: config.shuffle || false,
    fragments: config.fragments !== false,
    embedded: config.embedded || false,
    help: config.help !== false,
    showNotes: config.showNotes || false,
    autoSlide: config.autoSlide || 0,
    autoSlideStoppable: config.autoSlideStoppable !== false,
    mouseWheel: config.mouseWheel || false,
    hideAddressBar: config.hideAddressBar !== false,
    previewLinks: config.previewLinks || false,
    transitionSpeed: config.transitionSpeed || 'default',
    backgroundTransition: config.backgroundTransition || 'fade',
    viewDistance: config.viewDistance || 3,
  };

  // Formules : le greffon math, qui charge KaTeX du réseau au rendu. Exclu de l'export hors ligne,
  // où KaTeX manquerait ; gardé pour le PDF, qui attend KaTeX un temps borné et dit s'il manque.
  const usesMath = page.math ?? ((print || !inlinedAssets) && deckUsesMath(body));

  // Build CSS tags (for <head>)
  const theme = resolved.theme;
  const cssAssets = getCssAssets(theme);
  const cssTags = cssAssets.map((asset) => {
    if (inlinedAssets?.has(asset.url)) {
      const assetContent = inlinedAssets.get(asset.url)!;
      const attrsStr = asset.attrs ? ` ${asset.attrs}` : '';
      return `  <style${attrsStr}>\n${assetContent}\n  </style>`;
    }
    const attrsStr = asset.attrs ? ` ${asset.attrs}` : '';
    return `  <link rel="stylesheet" href="${asset.url}"${attrsStr ? ' ' + attrsStr : ''}>`;
  }).join('\n');

  // Build JS tags (for end of <body>)
  // Exclude math plugin for offline exports (KaTeX loads external CDN resources that fail offline)
  const jsAssets = getJsAssets({ includeMath: usesMath });
  const jsTags = jsAssets.map((asset) => {
    if (inlinedAssets?.has(asset.url)) {
      const assetContent = inlinedAssets.get(asset.url)!;
      const attrsStr = asset.attrs ? ` ${asset.attrs}` : '';
      return `  <script${attrsStr}>\n${assetContent}\n  </script>`;
    }
    const attrsStr = asset.attrs ? ` ${asset.attrs}` : '';
    return `  <script src="${asset.url}"${attrsStr ? ' ' + attrsStr : ''}></script>`;
  }).join('\n');

  // Build plugins list — only reference globals that are actually loaded
  const pluginsList = [
    'RevealMarkdown',
    'RevealHighlight',
    'RevealNotes',
    'RevealZoom',
    'RevealSearch',
    ...(usesMath ? ['RevealMath.KaTeX'] : []),
  ];

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${resolved.title}</title>

${cssTags}

  <style>
    .reveal h1, .reveal h2, .reveal h3, .reveal h4, .reveal h5, .reveal h6 {
      text-transform: none;
    }
    .reveal section img { border: none; box-shadow: none; background: none; }
    .reveal .author-info { margin-top: 2rem; font-size: 0.8em; opacity: 0.8; }
  </style>
</head>
<body${print ? ' class="reveal-viewport"' : ''}>
  <div class="reveal">
    <div class="slides">
${slidesHTML}
    </div>
  </div>

${jsTags}

  <script>
    // Build plugins array safely — skip any that failed to load
    var plugins = [${pluginsList.join(', ')}].filter(function(p) { return p != null; });

    Reveal.initialize({
      ...${JSON.stringify(revealConfig, null, 2)
        .split('\n')
        .map((line, i) => i === 0 ? line : '      ' + line)
        .join('\n')},
      plugins: plugins
    });
  </script>
${print ? printMarksScript() : ''}
</body>
</html>`;
};

/**
 * Le script de la page d'impression : il note la fin de la mise en page de reveal.js (`pdf-ready`,
 * que reveal.js émet une fois les pages posées, après `isReady()`) et l'échec du chargement de
 * KaTeX. Une ressource qui ne se charge pas émet `error` sur son élément, sans remonter : seule une
 * écoute en capture, sur la fenêtre, la voit.
 */
function printMarksScript(): string {
  return `  <script>
    (function () {
      var root = document.documentElement;
      window.addEventListener('error', function (event) {
        var target = event.target;
        var source = target && (target.src || target.href);
        if (typeof source === 'string' && source.indexOf('katex') !== -1) root.setAttribute('${MATH_FAILED_ATTR}', '');
      }, true);
      if (typeof Reveal !== 'undefined') {
        Reveal.on('pdf-ready', function () { root.setAttribute('${PDF_READY_ATTR}', ''); });
      }
    })();
  </script>`;
}

/**
 * La sonde de la mise en page d'impression, évaluée dans la fenêtre cachée. `no-reveal` : le
 * script de reveal.js n'a pas tourné (rien à attendre) ; `pending` : pas encore mise en pages ;
 * `math-pending` / `math-failed` : pages posées, formules pas encore rendues, ou KaTeX introuvable.
 * KaTeX rend les formules dès qu'il est chargé (`renderMathInElement`, qu'il définit alors).
 */
function printLayoutProbe(math: boolean): string {
  return `(() => {
    if (typeof Reveal === 'undefined') return 'no-reveal';
    const root = document.documentElement;
    if (!Reveal.isReady() || !root.hasAttribute('${PDF_READY_ATTR}')) return 'pending';
    if (${math} && typeof window.renderMathInElement !== 'function') {
      return root.hasAttribute('${MATH_FAILED_ATTR}') ? 'math-failed' : 'math-pending';
    }
    return 'ready';
  })()`;
}

/** Les fichiers de reveal.js n'ont pu venir ni du cache ni du réseau. */
class AssetsUnavailableError extends Error {
  readonly code = 'presentation.assetsUnavailable';

  constructor(cause: unknown) {
    super(`Fichiers de reveal.js indisponibles : ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'AssetsUnavailableError';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `work`, s'il aboutit dans `ms` ; `{ settled: false }` sinon. Son échec, lui, remonte : seul le
 * délai change d'issue. Un rejet tardif, une fois le délai passé, est lu ici et ne remonte pas.
 */
function within<T>(work: Promise<T>, ms: number): Promise<{ settled: true; value: T } | { settled: false }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ settled: false }), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve({ settled: true, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** `work`, ou `fallback` s'il n'a pas répondu dans `ms` (ou s'il a échoué). */
function settleWithin<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

// MARK: - Service

/** Un échec d'export de présentation : les fichiers de reveal.js manquants se disent par leur code. */
function failureOf(error: unknown): ExportResult {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof AssetsUnavailableError
    ? { success: false, error: message, errorCode: error.code }
    : { success: false, error: message };
}

/**
 * Chemin où écrire l'export : celui de la fenêtre, résolu contre le projet (un chemin
 * absolu reste tel quel), sinon le titre à côté du projet.
 */
function outputPathIn(options: RevealJsExportOptions, suffix: string): string {
  return options.outputPath
    ? resolvePath(options.projectPath, options.outputPath)
    : join(dirname(options.projectPath), `${options.metadata?.title || 'presentation'}${suffix}`);
}

/**
 * Les attentes bornées des exports PDF et hors ligne (L09-12). Mesurées sur un Mac M-series
 * (voir la PR) ; la marge couvre un réseau lent et un Mac ancien. Un dépassement est un échec dit,
 * ou une réserve, jamais une attente sans sortie, et reste sous la limite de l'export
 * (`export-time-limit.ts`).
 */
export interface RevealJsWaits {
  /** Le téléchargement d'un fichier de reveal.js ou d'une police, quand il n'est pas en cache. */
  assetTimeoutMs?: number;
  /**
   * Le chargement de la page d'impression (l'événement `load`, qu'attend reveal.js pour poser ses
   * pages) : au plus ce délai sans rien recevoir du réseau. Puis, une fois la page chargée, sa mise
   * en pages : au plus ce délai.
   */
  renderTimeoutMs?: number;
  /**
   * Le chargement de la page d'impression, tant qu'il reçoit encore : au plus ce délai en tout. Une
   * image d'archive lente qui arrive n'est pas coupée (revue de L09-12) ; une ressource qui envoie
   * un octet de temps à autre ne retient pas l'export jusqu'à sa limite.
   */
  loadLimitMs?: number;
}

/** Ce que la page d'impression a fait de son chargement. */
type PrintPageLoad =
  | { kind: 'loaded' }
  | {
      /** `stalled` : rien reçu pendant `renderTimeoutMs` ; `too-long` : reçoit encore à `loadLimitMs`. */
      kind: 'stalled' | 'too-long';
      /** Les adresses web que la page attendait encore. */
      pending: string[];
      /** `false` : le réseau de la page n'a pas pu être observé, `pending` ne dit rien. */
      observed: boolean;
    };

/** Les événements du protocole des outils de développement qui disent que la page reçoit encore. */
const NETWORK_PROGRESS = new Set([
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.dataReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
]);

/**
 * Le réseau de la page d'impression, vu par le protocole des outils de développement de sa fenêtre :
 * ce qu'elle attend encore, et quand elle a reçu quelque chose pour la dernière fois.
 * `Network.dataReceived` arrive à chaque morceau reçu (mesuré : une image envoyée en huit morceaux
 * en donne huit), ce que `webRequest` ne dit pas : il ne voit que le début et la fin.
 */
class PageNetwork {
  /** Les requêtes en cours : leur adresse, par identifiant. */
  private readonly inFlight = new Map<string, string>();
  lastActivity = Date.now();

  private readonly onMessage = (_event: unknown, method: string, params: unknown): void => {
    if (!NETWORK_PROGRESS.has(method)) return;
    this.lastActivity = Date.now();
    const { requestId, request } = (params ?? {}) as { requestId?: unknown; request?: { url?: unknown } };
    if (typeof requestId !== 'string') return;
    if (method === 'Network.requestWillBeSent') {
      // Une redirection revient sous le même identifiant : l'adresse gardée reste celle que la page
      // a demandée, écrite dans les diapositives (ou celle de KaTeX).
      if (typeof request?.url === 'string' && !this.inFlight.has(requestId)) this.inFlight.set(requestId, request.url);
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      this.inFlight.delete(requestId);
    }
  };

  /** Lève si le protocole ne s'attache pas. */
  constructor(private readonly protocol: Electron.Debugger) {
    protocol.attach('1.3');
    protocol.on('message', this.onMessage);
  }

  /** Les adresses web encore attendues (les `data:` et le fichier de la page n'attendent rien). */
  pending(): string[] {
    return [...new Set([...this.inFlight.values()].filter((url) => /^https?:/i.test(url)))];
  }

  stop(): void {
    this.protocol.removeListener('message', this.onMessage);
    try {
      if (this.protocol.isAttached()) this.protocol.detach();
    } catch {
      // Fenêtre déjà détruite : plus rien à détacher.
    }
  }
}

/** KaTeX, que le greffon des formules charge du réseau : ses scripts, sa feuille et ses polices. */
function isKatexResource(url: string): boolean {
  return /katex/i.test(url);
}

/**
 * L'échec d'une page d'impression qui ne s'est pas chargée : il nomme ce qu'elle attendait encore,
 * et dit si cela ne répondait plus ou arrivait trop lentement. Une ressource qui arrive ne se dit
 * jamais « sans réponse » (revue de L09-12).
 */
function pageLoadFailure(
  load: Exclude<PrintPageLoad, { kind: 'loaded' }>,
  resources: string[],
  waits: { idleMs: number; limitMs: number }
): ExportResult {
  if (resources.length === 0) {
    return {
      success: false,
      error: "Page d'impression non chargée dans le délai : une ressource demandée au réseau ne s'est pas chargée",
      errorCode: 'presentation.pageNotLoaded',
    };
  }
  const named = resources.slice(0, 5).join(', ') + (resources.length > 5 ? ', …' : '');
  if (load.kind === 'stalled') {
    const seconds = Math.max(1, Math.round(waits.idleMs / 1000));
    return {
      success: false,
      error: `Page d'impression non chargée : rien reçu depuis ${seconds} s de ${named}`,
      errorCode: 'presentation.resourceNotResponding',
      errorParams: { resources: named, count: resources.length, seconds },
    };
  }
  const minutes = Math.max(1, Math.round(waits.limitMs / 60_000));
  return {
    success: false,
    error: `Page d'impression non chargée : ${named} se télécharge encore au bout de ${minutes} min`,
    errorCode: 'presentation.pageLoadTooLong',
    errorParams: { resources: named, count: resources.length, minutes },
  };
}

/** Les fichiers de reveal.js inclus dans une page, et ce qui en manque. */
interface InlinedAssets {
  contents: Map<string, string>;
  /** Un fichier au moins venait du cache : à oublier si reveal.js ne tourne pas. */
  fromCache: boolean;
  /** Des polices du thème n'ont pu venir : la page les remplace par une police de repli. */
  fontsMissing: boolean;
}

/**
 * Le nom d'un fichier dans le cache. Celui des fichiers du CDN de reveal.js ne change pas, pour que
 * les caches déjà remplis servent encore ; les autres (Google Fonts, dont l'adresse a `?`, `:` et
 * `,`, interdits dans un nom de fichier sous Windows) prennent une empreinte de leur adresse.
 */
function cacheFileName(url: string): string {
  const legacy = url.replace(/https?:\/\/[^/]+\//, '').replace(/\//g, '__');
  if (url.startsWith(`${CDN_BASE}/`) && /^[\w.@-]+$/.test(legacy)) return legacy;
  return `${new URL(url).hostname}__${createHash('sha256').update(url).digest('hex').slice(0, 32)}`;
}

/**
 * Une page HTML là où on attend un script, une feuille de style ou une police : celle d'un portail
 * Wi-Fi, qu'une version d'avant L09-12 mettait en cache sans regarder.
 */
function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 256)).toString('latin1').trimStart().slice(0, 15).toLowerCase();
  return /^<(!doctype|html|head|body)\b/.test(head);
}

const ASSET_TIMEOUT_MS = 30_000;
const RENDER_TIMEOUT_MS = 30_000;
/**
 * Dix minutes de chargement qui progresse : une centaine de Mo d'images à 1,5 Mbit/s. Sous la limite
 * de l'export (15 min, `EXPORT_TIME_LIMIT_MS`), pour que l'échec nomme ce qui se télécharge encore.
 */
const LOAD_LIMIT_MS = 10 * 60_000;
const PROBE_INTERVAL_MS = 100;

export class RevealJsExportService {
  private readonly assetTimeoutMs: number;
  private readonly renderTimeoutMs: number;
  private readonly loadLimitMs: number;

  constructor(waits: RevealJsWaits = {}) {
    this.assetTimeoutMs = waits.assetTimeoutMs ?? ASSET_TIMEOUT_MS;
    this.renderTimeoutMs = waits.renderTimeoutMs ?? RENDER_TIMEOUT_MS;
    this.loadLimitMs = waits.loadLimitMs ?? LOAD_LIMIT_MS;
  }

  /**
   * Export markdown to reveal.js HTML presentation
   */
  async exportToRevealJs(
    options: RevealJsExportOptions,
    onProgress?: (progress: RevealJsProgress) => void,
    limits?: ExportLimits
  ): Promise<ExportResult> {
    // Jamais un fichier Markdown pour sortie : ce serait un texte de l'auteur (`export-output-path.ts`).
    const refused = refuseMarkdownOutput(options.projectPath, options.outputPath);
    if (refused) return refused;
    return withExportTimeLimit(limits, (clock) => this.runHtmlExport(options, onProgress, clock));
  }

  private async runHtmlExport(
    options: RevealJsExportOptions,
    onProgress: ((progress: RevealJsProgress) => void) | undefined,
    clock: ExportClock
  ): Promise<ExportResult> {
    try {
      onProgress?.({ stage: 'preparing', message: 'Préparation de la présentation...', progress: 20 });

      // Chemin de sortie résolu contre le projet, comme en PDF et en Word : un nom nu
      // (« diapos.html ») s'écrivait contre le dossier courant du processus, `/` pour
      // l'app lancée du Finder.
      const outputPath = outputPathIn(options, '.html');

      onProgress?.({ stage: 'converting', message: 'Génération HTML reveal.js...', progress: 50 });

      // Generate HTML
      const html = getRevealJsHTML(options.content, options);

      // Ensure output directory exists
      await mkdir(dirname(outputPath), { recursive: true });

      clock.throwIfExpired();

      // Write HTML file
      await writeFile(outputPath, html, 'utf-8');
      clock.throwIfExpired();

      onProgress?.({ stage: 'complete', message: 'Présentation créée!', progress: 100 });

      console.log('✅ Reveal.js presentation exported:', outputPath);

      // Non attendue : le fichier est écrit, l'export a réussi, quoi que fasse le
      // navigateur. L'attendre annoncerait un échec si l'ouverture ne rendait
      // jamais la main.
      void this.openInBrowser(outputPath);

      return { success: true, outputPath };
    } catch (error: unknown) {
      console.error('❌ Reveal.js export failed:', error);
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  /**
   * Ouverture dans le navigateur par défaut.
   * `shell.openPath` remplace l'ancienne interpolation dans un shell
   * (`open "${outputPath}"`) : un chemin contenant un guillemet en
   * échappait le quoting et permettait d'enchaîner une commande
   * arbitraire. Electron transmet ici le chemin à l'OS sans shell, et
   * couvre les trois plateformes d'un seul appel.
   */
  private async openInBrowser(outputPath: string): Promise<void> {
    try {
      const failure = await shell.openPath(outputPath);
      if (failure) {
        console.warn('⚠️ Failed to open browser automatically:', failure);
      } else {
        console.log('✅ Opened presentation in default browser');
      }
    } catch (error) {
      console.warn('⚠️ Failed to open browser automatically:', error);
    }
  }

  // ─── Offline Export ───────────────────────────────────────────────────────

  private cacheDir(): string {
    return join(app.getPath('userData'), 'reveal-assets-cache');
  }

  /**
   * Un fichier de reveal.js, ou une police de son thème : du cache (userData), sinon du réseau,
   * puis mis en cache. Le premier export PDF ou hors ligne demande le réseau ; les suivants s'en
   * passent.
   */
  private async fetchAsset(url: string): Promise<{ bytes: Buffer; fromCache: boolean }> {
    const cacheDir = this.cacheDir();
    const cachePath = join(cacheDir, cacheFileName(url));

    if (await pathExists(cachePath)) {
      const cached = await readFile(cachePath);
      // Vide, ou page de portail laissée par une version antérieure : reprise du réseau.
      if (cached.length > 0 && !looksLikeHtml(cached)) return { bytes: cached, fromCache: true };
    }

    // Borné : un réseau qui ne répond pas (pare-feu, connexion qui tombe) faisait attendre
    // l'export jusqu'à sa limite. `net.fetch` passe par la pile réseau de Chromium, qui suit le
    // proxy du système, comme la fenêtre qui chargeait reveal.js avant L09-12 ; le `fetch` de
    // Node l'ignore, et l'export échouerait derrière un proxy obligatoire.
    const response = await net.fetch(url, { signal: AbortSignal.timeout(this.assetTimeoutMs) });
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
    // Un portail Wi-Fi répond 200 avec sa page de connexion : en cache, elle remplacerait
    // reveal.js pour tous les exports suivants.
    if (/text\/html/i.test(response.headers.get('content-type') ?? '')) {
      throw new Error(`Failed to fetch ${url}: page HTML reçue au lieu du fichier`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (looksLikeHtml(bytes)) throw new Error(`Failed to fetch ${url}: page HTML reçue au lieu du fichier`);
    await mkdir(cacheDir, { recursive: true });
    await atomicWriteFile(cachePath, bytes);
    return { bytes, fromCache: false };
  }

  /**
   * Les fichiers de reveal.js, à inclure dans la page, feuilles de style rendues autonomes (polices
   * comprises) ; `AssetsUnavailableError` s'il manque un fichier de reveal.js. Une police manquante
   * n'arrête rien : elle est dite (`fontsMissing`).
   */
  private async inlineAssets(assets: CdnAsset[], clock: ExportClock): Promise<InlinedAssets> {
    const work = async (): Promise<InlinedAssets> => {
      const files = await Promise.all(assets.map((a) => this.fetchAsset(a.url))).catch((error: unknown) => {
        throw new AssetsUnavailableError(error);
      });
      const missing = new Set<string>();
      const load: ResourceLoader = async (url) => (await this.fetchAsset(url)).bytes;
      const texts = await Promise.all(
        assets.map((a, i) => {
          const text = files[i].bytes.toString('utf-8');
          return a.tag === 'style' ? selfContainedCss(text, a.url, load, missing) : text;
        })
      );
      if (missing.size > 0) console.warn('⚠️ reveal.js : polices du thème indisponibles :', [...missing]);
      return {
        contents: new Map(assets.map((a, i) => [a.url, texts[i]])),
        fromCache: files.some((f) => f.fromCache),
        fontsMissing: missing.size > 0,
      };
    };
    return clock.run(work());
  }

  /** Oublie ces fichiers du cache : le prochain `inlineAssets` les reprend du réseau. */
  private async forgetCachedAssets(assets: CdnAsset[]): Promise<void> {
    await Promise.all(assets.map((a) => rm(join(this.cacheDir(), cacheFileName(a.url)), { force: true })));
  }

  /**
   * Les fichiers de la page d'impression : ceux de reveal.js, obligatoires, et le greffon des
   * formules si le deck en a, facultatif. Le HTML autonome ne le met jamais en cache, et hors ligne
   * KaTeX manquerait de toute façon : obligatoire, il faisait échouer tout l'export PDF d'un deck à
   * formules (revue de L09-12). Absent, la page se fait sans lui (`mathPlugin` faux).
   */
  private async printAssets(
    assets: CdnAsset[],
    deckMath: boolean,
    clock: ExportClock
  ): Promise<{ inlined: InlinedAssets; mathPlugin: boolean }> {
    const inlined = await this.inlineAssets(assets, clock);
    if (!deckMath) return { inlined, mathPlugin: false };
    const plugin = await clock.run(
      this.fetchAsset(MATH_ASSET.url).catch((error: unknown) => {
        console.warn('⚠️ reveal.js : greffon des formules indisponible, PDF sans KaTeX :', error);
        return null;
      })
    );
    if (plugin) inlined.contents.set(MATH_ASSET.url, plugin.bytes.toString('utf-8'));
    return { inlined, mathPlugin: plugin !== null };
  }

  /**
   * Observe le réseau de la page d'impression, ou `null` si l'observation ne démarre pas : le
   * chargement reste alors borné au total par `renderTimeoutMs`, comme avant. Le protocole ne répond
   * qu'une fois une page chargée (mesuré : `Network.enable` reste sans réponse sur une fenêtre
   * neuve), d'où une page vide d'abord ; activé après le début du chargement, il manque les premières
   * requêtes et leur adresse.
   */
  private async watchNetwork(win: BrowserWindow, clock: ExportClock): Promise<PageNetwork | null> {
    const settles = (start: () => Promise<unknown>): Promise<boolean> => {
      let work: Promise<boolean>;
      try {
        work = start().then(() => true);
      } catch (error: unknown) {
        work = Promise.reject(error);
      }
      return clock.run(settleWithin(work, this.renderTimeoutMs, false));
    };
    const unavailable = (why: string): null => {
      console.warn(`⚠️ reveal.js : réseau de la page d'impression non observé (${why}), chargement borné au total`);
      return null;
    };

    if (!(await settles(() => win.loadURL('data:text/html,')))) return unavailable("page d'amorce");
    let network: PageNetwork;
    try {
      network = new PageNetwork(win.webContents.debugger);
    } catch (error: unknown) {
      return unavailable(error instanceof Error ? error.message : String(error));
    }
    if (!(await settles(() => win.webContents.debugger.sendCommand('Network.enable')))) {
      network.stop();
      return unavailable('Network.enable');
    }
    return network;
  }

  /**
   * Charge la page d'impression. `loadFile` attend l'événement `load`, qui attend tout ce que la
   * page demande, et reveal.js n'en pose les pages qu'après lui. Un réseau qui accepte la connexion
   * sans répondre tenait donc l'export jusqu'à sa limite ; borné au total (30 s), il coupait une
   * image lente qui arrivait (revue de L09-12). C'est l'inactivité qui est bornée : rien reçu
   * pendant `renderTimeoutMs`. Le total l'est aussi, plus largement (`loadLimitMs`).
   */
  private async loadPrintPage(win: BrowserWindow, file: string, clock: ExportClock): Promise<PrintPageLoad> {
    const network = await this.watchNetwork(win, clock);
    const started = Date.now();
    // Le mode impression de reveal.js se déclenche par l'URL, pas par une classe posée sur
    // `.reveal` : sans `?print-pdf`, seule la diapositive courante est rendue et le PDF n'en
    // contient qu'une.
    const loading = win.loadFile(file, { search: 'print-pdf' });
    // Abandonnée, la page rejette quand sa fenêtre est détruite : ce rejet n'a plus de lecteur.
    loading.catch(() => undefined);
    try {
      for (;;) {
        const now = Date.now();
        const idleLeft = this.renderTimeoutMs - (now - (network?.lastActivity ?? started));
        const limitLeft = this.loadLimitMs - (now - started);
        if (idleLeft <= 0 || limitLeft <= 0) {
          return {
            kind: idleLeft <= 0 ? 'stalled' : 'too-long',
            pending: network?.pending() ?? [],
            observed: network !== null,
          };
        }
        // Jusqu'à la première échéance possible ; ce qui est reçu d'ici là la repousse.
        const step = await clock.run(within(loading, Math.min(idleLeft, limitLeft)));
        if (step.settled) return { kind: 'loaded' };
      }
    } finally {
      network?.stop();
    }
  }

  /**
   * Attend que reveal.js ait mis la présentation en pages d'impression, au plus `renderTimeoutMs`
   * après le chargement de la page. `Reveal.isReady()` ne suffit pas : il précède la mise en pages,
   * que reveal.js annonce par `pdf-ready`. Imprimer plus tôt, c'était imprimer des `<textarea>` de
   * markdown brut quand reveal.js ne s'était pas chargé, ou une page à moitié posée (S12-1-18).
   *
   * Rend `ready`, `math-missing` (pages posées, formules non rendues : KaTeX vient du réseau),
   * `no-reveal` (le script de reveal.js n'a pas tourné : inutile d'attendre) ou `timed-out`.
   */
  private async waitForPrintLayout(
    win: BrowserWindow,
    math: boolean,
    clock: ExportClock
  ): Promise<'ready' | 'math-missing' | 'no-reveal' | 'timed-out'> {
    const started = Date.now();
    const deadline = started + this.renderTimeoutMs;
    const probe = printLayoutProbe(math);
    let state: unknown = 'pending';
    for (let left = this.renderTimeoutMs; left > 0; left = deadline - Date.now()) {
      // Une page bloquée ne répond pas à la sonde : chaque appel est borné lui aussi.
      state = await clock.run(settleWithin<unknown>(win.webContents.executeJavaScript(probe), left, 'pending'));
      if (state === 'ready') {
        console.log(`⏱ reveal.js : présentation mise en pages en ${Date.now() - started} ms`);
        return 'ready';
      }
      if (state === 'math-failed') return 'math-missing';
      if (state === 'no-reveal') return 'no-reveal';
      await clock.run(delay(Math.min(PROBE_INTERVAL_MS, Math.max(0, deadline - Date.now()))));
    }
    return state === 'math-pending' ? 'math-missing' : 'timed-out';
  }

  /**
   * Export to a self-contained offline HTML (all assets inlined, no CDN).
   * Assets are cached in userData on first call.
   */
  async exportOffline(
    options: RevealJsExportOptions,
    onProgress?: (progress: RevealJsProgress) => void,
    limits?: ExportLimits
  ): Promise<ExportResult> {
    // Jamais un fichier Markdown pour sortie : ce serait un texte de l'auteur (`export-output-path.ts`).
    const refused = refuseMarkdownOutput(options.projectPath, options.outputPath);
    if (refused) return refused;
    return withExportTimeLimit(limits, (clock) => this.runOfflineExport(options, onProgress, clock));
  }

  private async runOfflineExport(
    options: RevealJsExportOptions,
    onProgress: ((progress: RevealJsProgress) => void) | undefined,
    clock: ExportClock
  ): Promise<ExportResult> {
    try {
      onProgress?.({ stage: 'preparing', message: 'Téléchargement des assets reveal.js...', progress: 10 });

      // Thème effectif (frontmatter > reveal-config) — les assets inlinés
      // doivent correspondre au thème réellement rendu.
      const theme = resolveDeckConfig(options.content, options).theme;
      // Sans le greffon des formules : KaTeX se charge du réseau au rendu.
      const inlined = await this.inlineAssets(getAllCdnAssets(theme), clock);

      onProgress?.({ stage: 'converting', message: 'Génération HTML offline...', progress: 70 });

      const html = getRevealJsHTML(options.content, options, inlined.contents);
      const outputPath = outputPathIn(options, '-offline.html');

      await mkdir(dirname(outputPath), { recursive: true });
      clock.throwIfExpired();
      await writeFile(outputPath, html, 'utf-8');
      clock.throwIfExpired();

      // Le fichier ne demande rien au dehors : sans KaTeX, les formules y restent telles qu'écrites,
      // et la fiche de L09-12 demande de le dire.
      const warnings: OutcomeIssue[] = [];
      if (inlined.fontsMissing) warnings.push({ code: 'presentation.themeFontsMissing' });
      if (deckUsesMath(extractDeck(options.content).body)) warnings.push({ code: 'presentation.mathNotIncludedOffline' });

      onProgress?.({ stage: 'complete', message: 'Présentation offline créée!', progress: 100 });
      return { success: true, outputPath, ...(warnings.length > 0 ? { warnings } : {}) };
    } catch (error: unknown) {
      console.error('❌ Offline export failed:', error);
      return failureOf(error);
    }
  }

  // ─── PDF Export ────────────────────────────────────────────────────────────

  /**
   * Export to PDF via a hidden BrowserWindow with reveal.js ?print-pdf mode.
   */
  async exportToPDF(
    options: RevealJsExportOptions,
    onProgress?: (progress: RevealJsProgress) => void,
    limits?: ExportLimits
  ): Promise<ExportResult> {
    // Jamais un fichier Markdown pour sortie : ce serait un texte de l'auteur (`export-output-path.ts`).
    const refused = refuseMarkdownOutput(options.projectPath, options.outputPath);
    if (refused) return refused;
    return withExportTimeLimit(limits, (clock) => this.runPdfExport(options, onProgress, clock));
  }

  private async runPdfExport(
    options: RevealJsExportOptions,
    onProgress: ((progress: RevealJsProgress) => void) | undefined,
    clock: ExportClock
  ): Promise<ExportResult> {
    let win: BrowserWindow | null = null;
    const tmpHtml = join(tmpdir(), `cliodeck-pdf-export-${Date.now()}.html`);
    // `destroy` et non `close`, qui peut attendre une page bloquée.
    clock.onExpire(() => {
      if (win && !win.isDestroyed()) win.destroy();
    });

    try {
      onProgress?.({ stage: 'preparing', message: 'Préparation HTML pour impression...', progress: 15 });

      // reveal.js inclus dans la page, du cache ou du réseau, comme l'export hors ligne : chargé du
      // CDN par la fenêtre, il manquait hors ligne, et la page imprimée n'était que du markdown
      // brut ; sur un réseau qui ne répond pas, la fenêtre attendait ses scripts sans fin.
      const theme = resolveDeckConfig(options.content, options).theme;
      const deckMath = deckUsesMath(extractDeck(options.content).body);
      const assets = getAllCdnAssets(theme);
      let { inlined, mathPlugin } = await this.printAssets(assets, deckMath, clock);
      let math = mathPlugin;
      let mathMissing = deckMath && !mathPlugin;
      let cacheForgotten = false;

      onProgress?.({ stage: 'converting', message: 'Rendu de la présentation...', progress: 40 });

      // Trois pages au plus : la première ; une sans formules si KaTeX, seul fichier encore demandé
      // au réseau, la fait attendre ; une avec reveal.js repris du réseau si celui du cache ne
      // tourne pas. Chaque attente est bornée.
      for (;;) {
        const html = getRevealJsHTML(options.content, options, inlined.contents, { print: true, math });
        await writeFile(tmpHtml, html, 'utf-8');
        clock.throwIfExpired();
        if (win && !win.isDestroyed()) win.destroy();

        win = new BrowserWindow({
          show: false,
          width: 1280,
          height: 960,
          webPreferences: { nodeIntegration: false, contextIsolation: true },
        });

        const load = await this.loadPrintPage(win, tmpHtml, clock);
        if (load.kind !== 'loaded') {
          const others = load.pending.filter((url) => !isKatexResource(url));
          // Seul KaTeX fait attendre la page, ou rien ne dit ce qu'elle attend (réseau non observé) :
          // refaite sans le greffon des formules, qui restent telles qu'écrites, et la réserve le
          // dit. Une autre ressource en attente ferait attendre la seconde page de même : KaTeX
          // n'est pas mis en cause.
          if (math && others.length === 0 && (load.pending.length > 0 || !load.observed)) {
            console.warn("⚠️ reveal.js : page d'impression retenue par KaTeX, refaite sans formules");
            math = false;
            mathMissing = true;
            continue;
          }
          const failure = pageLoadFailure(load, others, { idleMs: this.renderTimeoutMs, limitMs: this.loadLimitMs });
          console.error('❌ PDF export failed:', failure.error);
          return failure;
        }

        const layout = await this.waitForPrintLayout(win, math, clock);
        if (layout === 'no-reveal' && inlined.fromCache && !cacheForgotten) {
          // Un fichier du cache qui ne tourne pas (tronqué, ou page de portail d'une version
          // antérieure) : il ferait échouer chaque export, et le HTML autonome qui l'inclut aussi.
          console.warn('⚠️ reveal.js du cache absent de la page : fichiers repris du réseau');
          cacheForgotten = true;
          await clock.run(this.forgetCachedAssets(deckMath ? [...assets, MATH_ASSET] : assets));
          ({ inlined, mathPlugin } = await this.printAssets(assets, deckMath, clock));
          math = math && mathPlugin;
          mathMissing ||= deckMath && !mathPlugin;
          continue;
        }
        if (layout === 'no-reveal' || layout === 'timed-out') {
          const error =
            layout === 'no-reveal'
              ? "reveal.js absent de la page d'impression"
              : `reveal.js n'a pas mis la présentation en pages en ${this.renderTimeoutMs} ms`;
          console.error('❌ PDF export failed:', error);
          return { success: false, error, errorCode: 'presentation.notRendered' };
        }
        if (layout === 'math-missing') mathMissing = true;
        break;
      }

      const warnings: OutcomeIssue[] = [];
      if (inlined.fontsMissing) warnings.push({ code: 'presentation.themeFontsMissing' });
      if (mathMissing) warnings.push({ code: 'presentation.mathNotRendered' });

      onProgress?.({ stage: 'converting', message: 'Génération du PDF...', progress: 70 });

      // La taille de page vient de reveal.js, qui déclare en CSS (`@page`)
      // celle de ses diapositives. Ne pas la redonner ici : `pageSize` se
      // compte en pouces, et les 254000 × 190500 d'origine (des microns)
      // donnaient des pages de plusieurs kilomètres, qu'Electron 43 refuse.
      const pdfData = await clock.run(win.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
      }));

      const outputPath = outputPathIn(options, '.pdf');

      await mkdir(dirname(outputPath), { recursive: true });
      clock.throwIfExpired();
      await writeFile(outputPath, pdfData);
      clock.throwIfExpired();

      onProgress?.({ stage: 'complete', message: 'PDF créé!', progress: 100 });
      return { success: true, outputPath, ...(warnings.length > 0 ? { warnings } : {}) };
    } catch (error: unknown) {
      console.error('❌ PDF export failed:', error);
      return failureOf(error);
    } finally {
      if (win && !win.isDestroyed()) win.close();
      // Le HTML intermédiaire contient toute la présentation : on le
      // supprime (l'ancienne version se contentait de le vider, sans
      // attendre la fin de l'écriture).
      await rm(tmpHtml, { force: true }).catch((err) => {
        console.warn('⚠️ Failed to clean PDF export temp file:', err);
      });
    }
  }
}

export const revealJsExportService = new RevealJsExportService();
