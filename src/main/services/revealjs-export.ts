import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import { join, dirname, resolve as resolvePath } from 'path';
import { tmpdir } from 'os';
import { app, BrowserWindow, shell } from 'electron';
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
  if (options?.includeMath) {
    assets.push({ url: `${CDN_BASE}/plugin/math/math.js`, tag: 'script' });
  }
  return assets;
};

/** All assets for fetching / caching (offline export) */
const getAllCdnAssets = (theme: string, options?: { includeMath?: boolean }): CdnAsset[] => [
  ...getCssAssets(theme),
  ...getJsAssets(options),
];

/**
 * Le deck a-t-il des formules (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) ? Lu sur le corps : le
 * frontmatter n'est pas du contenu.
 */
function deckUsesMath(body: string): boolean {
  return /(\$\$.+?\$\$|\$[^$\n]+\$|\\\(.+?\\\)|\\\[.+?\\\])/s.test(body);
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
 * lieu d'être chargés du CDN (export hors ligne et PDF). `print` : la page que l'export PDF imprime,
 * en mode impression de reveal.js, avec les marques que lit la sonde.
 */
const getRevealJsHTML = (
  content: string,
  options: RevealJsExportOptions,
  inlinedAssets?: Map<string, string>,
  print = false
): string => {
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
  const usesMath = (print || !inlinedAssets) && deckUsesMath(body);

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
 * Les deux attentes bornées des exports PDF et hors ligne (L09-12). Mesurées sur un Mac M-series
 * (voir la PR) ; la marge couvre un réseau lent et un Mac ancien. Un dépassement est un échec dit,
 * jamais une attente sans sortie, et reste sous la limite de l'export (`export-time-limit.ts`).
 */
export interface RevealJsWaits {
  /** Le téléchargement d'un fichier de reveal.js, quand il n'est pas en cache. */
  assetTimeoutMs?: number;
  /** La mise en pages d'impression, une fois la page chargée. */
  renderTimeoutMs?: number;
}

const ASSET_TIMEOUT_MS = 30_000;
const RENDER_TIMEOUT_MS = 30_000;
const PROBE_INTERVAL_MS = 100;

export class RevealJsExportService {
  private readonly assetTimeoutMs: number;
  private readonly renderTimeoutMs: number;

  constructor(waits: RevealJsWaits = {}) {
    this.assetTimeoutMs = waits.assetTimeoutMs ?? ASSET_TIMEOUT_MS;
    this.renderTimeoutMs = waits.renderTimeoutMs ?? RENDER_TIMEOUT_MS;
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

  /**
   * Un fichier de reveal.js : du cache (userData), sinon du CDN, puis mis en cache. Le premier
   * export PDF ou hors ligne demande le réseau ; les suivants s'en passent.
   */
  private async fetchAsset(url: string, cacheDir: string): Promise<string> {
    // Derive a safe filename from the URL path
    const key = url.replace(/https?:\/\/[^/]+\//, '').replace(/\//g, '__');
    const cachePath = join(cacheDir, key);

    if (await pathExists(cachePath)) return readFile(cachePath, 'utf-8');

    // Borné : un réseau qui ne répond pas (pare-feu, connexion qui tombe) faisait attendre
    // l'export jusqu'à sa limite.
    const response = await fetch(url, { signal: AbortSignal.timeout(this.assetTimeoutMs) });
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
    // Un portail Wi-Fi répond 200 avec sa page de connexion : en cache, elle remplacerait
    // reveal.js pour tous les exports suivants.
    if (/text\/html/i.test(response.headers.get('content-type') ?? '')) {
      throw new Error(`Failed to fetch ${url}: page HTML reçue au lieu du fichier`);
    }
    const text = await response.text();
    await mkdir(cacheDir, { recursive: true });
    await atomicWriteFile(cachePath, text);
    return text;
  }

  /** Les fichiers de reveal.js, à inclure dans la page ; `AssetsUnavailableError` s'il en manque un. */
  private async inlineAssets(assets: CdnAsset[], clock: ExportClock): Promise<Map<string, string>> {
    const cacheDir = join(app.getPath('userData'), 'reveal-assets-cache');
    const fetched = Promise.all(assets.map((a) => this.fetchAsset(a.url, cacheDir))).catch(
      (error: unknown) => {
        throw new AssetsUnavailableError(error);
      }
    );
    const contents = await clock.run(fetched);
    return new Map(assets.map((a, i) => [a.url, contents[i]]));
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
      // Exclude math plugin from offline — KaTeX loads external CDN resources at runtime
      const inlinedAssets = await this.inlineAssets(getAllCdnAssets(theme, { includeMath: false }), clock);

      onProgress?.({ stage: 'converting', message: 'Génération HTML offline...', progress: 70 });

      const html = getRevealJsHTML(options.content, options, inlinedAssets);
      const outputPath = outputPathIn(options, '-offline.html');

      await mkdir(dirname(outputPath), { recursive: true });
      clock.throwIfExpired();
      await writeFile(outputPath, html, 'utf-8');
      clock.throwIfExpired();

      onProgress?.({ stage: 'complete', message: 'Présentation offline créée!', progress: 100 });
      return { success: true, outputPath };
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
      const math = deckUsesMath(extractDeck(options.content).body);
      const inlinedAssets = await this.inlineAssets(getAllCdnAssets(theme, { includeMath: math }), clock);
      const html = getRevealJsHTML(options.content, options, inlinedAssets, true);

      await writeFile(tmpHtml, html, 'utf-8');

      onProgress?.({ stage: 'converting', message: 'Rendu de la présentation...', progress: 40 });

      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 960,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });

      // Le mode impression de reveal.js se déclenche par l'URL, pas par une
      // classe posée sur `.reveal` : sans `?print-pdf`, seule la diapositive
      // courante est rendue et le PDF n'en contient qu'une.
      await clock.run(win.loadFile(tmpHtml, { search: 'print-pdf' }));

      const layout = await this.waitForPrintLayout(win, math, clock);
      if (layout === 'no-reveal' || layout === 'timed-out') {
        const error =
          layout === 'no-reveal'
            ? "reveal.js absent de la page d'impression"
            : `reveal.js n'a pas mis la présentation en pages en ${this.renderTimeoutMs} ms`;
        console.error('❌ PDF export failed:', error);
        return { success: false, error, errorCode: 'presentation.notRendered' };
      }
      const warnings: OutcomeIssue[] =
        layout === 'math-missing' ? [{ code: 'presentation.mathNotRendered' }] : [];

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
