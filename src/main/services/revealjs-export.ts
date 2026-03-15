import { writeFile, readFile, mkdir, access } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { app, BrowserWindow } from 'electron';

const execAsync = promisify(exec);

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

// MARK: - Slide parsing (shared between export & preview)

/**
 * Parse markdown content into a 2D slide structure.
 *
 *  # Title        → new horizontal section (navigate left/right)
 *  ## Sub-title   → new vertical slide within the current section (navigate up/down)
 *  ---            → explicit slide separator (vertical within current section)
 *  Note: …        → speaker notes (everything after "Note:" until end of slide block)
 */
interface ParsedSlide { markdown: string; notes: string }
type SlideSection = ParsedSlide[];

function parseSlides(content: string): SlideSection[] {
  const extractNotes = (raw: string): ParsedSlide => {
    const m = raw.match(/\n\s*Notes?:\s*([\s\S]*)$/im);
    if (m) return { markdown: raw.slice(0, m.index!).trim(), notes: m[1].trim() };
    return { markdown: raw.trim(), notes: '' };
  };

  const sections: SlideSection[] = [];
  let cur: ParsedSlide[] = [];

  for (const rawSlide of content.split(/\n---\n/)) {
    const trimmed = rawSlide.trim();
    if (!trimmed) continue;

    const firstLine = trimmed.split('\n')[0];
    const startsWithH1 = /^#(?!#)\s+/.test(firstLine);
    const startsWithH2 = /^##(?!#)\s+/.test(firstLine);

    if (startsWithH1) {
      if (cur.length) { sections.push(cur); cur = []; }
      for (const part of trimmed.split(/\n(?=##(?!#)\s)/)) {
        const p = part.trim();
        if (p) cur.push(extractNotes(p));
      }
    } else if (startsWithH2) {
      cur.push(extractNotes(trimmed));
    } else {
      cur.push(extractNotes(trimmed));
    }
  }
  if (cur.length) sections.push(cur);
  return sections;
}

// MARK: - Preview (lightweight, self-contained)

/**
 * Generates a lightweight, self-contained preview HTML.
 * No CDN dependencies — works reliably inside Electron iframe srcDoc.
 * Includes a tiny inline markdown renderer.
 */
export function generatePreviewHtml(content: string, _options: RevealJsExportOptions): string {
  const sections = parseSlides(content);
  const theme = _options.config?.theme || 'black';

  // Flatten all slides with section/slide indices for the navigation label
  const flatSlides: { md: string; notes: string; label: string }[] = [];
  sections.forEach((sec, si) => {
    sec.forEach((slide, vi) => {
      const label = sec.length > 1 ? `${si + 1}.${vi + 1}` : `${si + 1}`;
      flatSlides.push({ md: slide.markdown, notes: slide.notes, label });
    });
  });

  if (!flatSlides.length) {
    flatSlides.push({ md: '*Aucun contenu*', notes: '', label: '1' });
  }

  // Inline slide divs (markdown rendered by a tiny JS function at runtime)
  const slideDivs = flatSlides.map((s, i) => {
    const mdEsc = s.md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const notesEsc = s.notes.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="slide${i === 0 ? ' active' : ''}" data-index="${i}">
      <span class="slide-num">${s.label}</span>
      <div class="slide-body" data-md="${mdEsc.replace(/"/g, '&quot;')}"></div>
      ${s.notes ? `<div class="slide-notes" data-md="${notesEsc.replace(/"/g, '&quot;')}"></div>` : ''}
    </div>`;
  }).join('\n');

  const isDark = !['white', 'beige', 'sky', 'serif', 'simple', 'solarized'].includes(theme);
  const bg = isDark ? '#191919' : '#f5f5f0';
  const fg = isDark ? '#eee' : '#222';
  const fgMuted = isDark ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.4)';
  const accent = isDark ? '#42affa' : '#2a76dd';
  const noteBg = isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.04)';

  // Build the inline <script> as a plain string to avoid template-literal
  // escaping issues with regex backslashes.
  const PREVIEW_SCRIPT = [
    'function md(s){',
    '  s=s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,\'"\');',
    '  s=s.replace(/```(\\w*)?\\n([\\s\\S]*?)```/g,function(_,l,c){',
    '    c=c.replace(/</g,"&lt;").replace(/>/g,"&gt;");',
    '    return "<pre><code>"+c.trim()+"</code></pre>";',
    '  });',
    '  var lines=s.split("\\n"),out=[],inUl=false,inOl=false;',
    '  for(var i=0;i<lines.length;i++){',
    '    var L=lines[i];',
    '    if(/^######\\s/.test(L)){L="<h6>"+L.slice(7)+"</h6>";}',
    '    else if(/^#####\\s/.test(L)){L="<h5>"+L.slice(6)+"</h5>";}',
    '    else if(/^####\\s/.test(L)){L="<h4>"+L.slice(5)+"</h4>";}',
    '    else if(/^###\\s/.test(L)){L="<h3>"+L.slice(4)+"</h3>";}',
    '    else if(/^##\\s/.test(L)){L="<h2>"+L.slice(3)+"</h2>";}',
    '    else if(/^#\\s/.test(L)){L="<h1>"+L.slice(2)+"</h1>";}',
    '    else if(/^>\\s?/.test(L)){L="<blockquote>"+L.replace(/^>\\s?/,"")+"</blockquote>";}',
    '    else if(/^\\s*[-*+]\\s/.test(L)){',
    '      if(!inUl){out.push("<ul>");inUl=true;}',
    '      L="<li>"+L.replace(/^\\s*[-*+]\\s/,"")+"</li>";',
    '    }',
    '    else if(/^\\s*\\d+\\.\\s/.test(L)){',
    '      if(!inOl){out.push("<ol>");inOl=true;}',
    '      L="<li>"+L.replace(/^\\s*\\d+\\.\\s/,"")+"</li>";',
    '    }',
    '    else{',
    '      if(inUl){out.push("</ul>");inUl=false;}',
    '      if(inOl){out.push("</ol>");inOl=false;}',
    '      if(L.trim()===""&&!/</.test(L)){L="";}',
    '      else if(!/^</.test(L)){L="<p>"+L+"</p>";}',
    '    }',
    '    out.push(L);',
    '  }',
    '  if(inUl)out.push("</ul>");',
    '  if(inOl)out.push("</ol>");',
    '  s=out.join("\\n");',
    '  s=s.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g,"<img src=\\"$2\\" alt=\\"$1\\">");',
    '  s=s.replace(/\\[([^\\]]*)\\]\\(([^)]+)\\)/g,"<a href=\\"$2\\">$1</a>");',
    '  s=s.replace(/`([^`]+)`/g,"<code>$1</code>");',
    '  s=s.replace(/\\*\\*(.+?)\\*\\*/g,"<strong>$1</strong>");',
    '  s=s.replace(/\\*(.+?)\\*/g,"<em>$1</em>");',
    '  s=s.replace(/<p><\\/p>/g,"");',
    '  return s;',
    '}',
    'document.querySelectorAll("[data-md]").forEach(function(el){',
    '  el.innerHTML=md(el.getAttribute("data-md"));',
    '});',
    'var slides=document.querySelectorAll(".slide");',
    'var cur=0,total=slides.length;',
    'function show(n){',
    '  if(n<0||n>=total)return;',
    '  slides[cur].classList.remove("active");',
    '  cur=n;',
    '  slides[cur].classList.add("active");',
    '  slides[cur].scrollIntoView({block:"nearest",behavior:"smooth"});',
    '  document.getElementById("counter").textContent=(cur+1)+" / "+total;',
    '}',
    'function go(d){show(cur+d);}',
    'document.querySelectorAll(".slide").forEach(function(el){',
    '  el.addEventListener("click",function(){show(+el.getAttribute("data-index"));});',
    '});',
  ].join('\n');

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
  <div class="slides" id="scroller">${slideDivs}</div>
  <div class="nav">
    <button onclick="go(-1)">&#9664;</button>
    <span id="counter">1 / ${flatSlides.length}</span>
    <button onclick="go(1)">&#9654;</button>
  </div>
</div>
<script>${PREVIEW_SCRIPT}<\/script></body></html>`;
}

// MARK: - Reveal.js export templates

const getRevealJsHTML = (content: string, options: RevealJsExportOptions, inlinedAssets?: Map<string, string>): string => {
  const config = options.config || {};
  const metadata = options.metadata || {};

  const sections = parseSlides(content);

  // ── Build slides HTML ─────────────────────────────────────────────────
  // Notes stay inside the <textarea>; the reveal.js markdown plugin
  // extracts them via its built-in notesSeparator regex.

  const slideToHTML = (s: ParsedSlide): string => {
    // Re-assemble the markdown with notes for the reveal.js markdown plugin
    const fullMd = s.notes ? `${s.markdown}\n\nNote:\n${s.notes}` : s.markdown;
    return `          <section data-markdown>\n            <textarea data-template>\n${fullMd}\n            </textarea>\n          </section>`;
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
    theme: config.theme || 'black',
    transition: config.transition || 'slide',
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

  // Detect whether content uses math ($ delimiters or \( \[ )
  const usesMath = !inlinedAssets && /(\$\$.+?\$\$|\$[^$\n]+\$|\\\(.+?\\\)|\\\[.+?\\\])/s.test(content);

  // Build CSS tags (for <head>)
  const theme = config.theme || 'black';
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
  <title>${metadata.title || 'Présentation'}</title>

${cssTags}

  <style>
    .reveal h1, .reveal h2, .reveal h3, .reveal h4, .reveal h5, .reveal h6 {
      text-transform: none;
    }
    .reveal section img { border: none; box-shadow: none; background: none; }
    .reveal .author-info { margin-top: 2rem; font-size: 0.8em; opacity: 0.8; }
  </style>
</head>
<body>
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
</body>
</html>`;
};

// MARK: - Service

export class RevealJsExportService {
  /**
   * Export markdown to reveal.js HTML presentation
   */
  async exportToRevealJs(
    options: RevealJsExportOptions,
    onProgress?: (progress: RevealJsProgress) => void
  ): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    try {
      onProgress?.({ stage: 'preparing', message: 'Préparation de la présentation...', progress: 20 });

      // Determine output path
      const outputPath = options.outputPath || join(dirname(options.projectPath), `${options.metadata?.title || 'presentation'}.html`);

      onProgress?.({ stage: 'converting', message: 'Génération HTML reveal.js...', progress: 50 });

      // Generate HTML
      const html = getRevealJsHTML(options.content, options);

      // Ensure output directory exists
      await mkdir(dirname(outputPath), { recursive: true });

      // Write HTML file
      await writeFile(outputPath, html, 'utf-8');

      onProgress?.({ stage: 'complete', message: 'Présentation créée!', progress: 100 });

      console.log('✅ Reveal.js presentation exported:', outputPath);

      // Open in default browser
      try {
        const platform = process.platform;
        let command: string;

        if (platform === 'darwin') {
          command = `open "${outputPath}"`;
        } else if (platform === 'win32') {
          command = `start "" "${outputPath}"`;
        } else {
          // Linux
          command = `xdg-open "${outputPath}"`;
        }

        await execAsync(command);
        console.log('✅ Opened presentation in default browser');
      } catch (error) {
        console.warn('⚠️ Failed to open browser automatically:', error);
        // Don't fail the export if browser opening fails
      }

      return { success: true, outputPath };
    } catch (error: any) {
      console.error('❌ Reveal.js export failed:', error);
      return { success: false, error: error.message };
    }
  }

  // ─── Offline Export ───────────────────────────────────────────────────────

  /**
   * Fetches a CDN asset, caching it in userData for subsequent uses.
   */
  private async fetchAsset(url: string, cacheDir: string): Promise<string> {
    // Derive a safe filename from the URL path
    const key = url.replace(/https?:\/\/[^/]+\//, '').replace(/\//g, '__');
    const cachePath = join(cacheDir, key);

    try {
      await access(cachePath);
      return readFile(cachePath, 'utf-8');
    } catch {
      // Not cached yet — fetch
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
      const text = await response.text();
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, text, 'utf-8');
      return text;
    }
  }

  /**
   * Export to a self-contained offline HTML (all assets inlined, no CDN).
   * Assets are cached in userData on first call.
   */
  async exportOffline(
    options: RevealJsExportOptions,
    onProgress?: (progress: RevealJsProgress) => void
  ): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    try {
      onProgress?.({ stage: 'preparing', message: 'Téléchargement des assets reveal.js...', progress: 10 });

      const cacheDir = join(app.getPath('userData'), 'reveal-assets-cache');
      const theme = options.config?.theme || 'black';
      // Exclude math plugin from offline — KaTeX loads external CDN resources at runtime
      const assets = getAllCdnAssets(theme, { includeMath: false });

      // Fetch all assets (parallelized)
      const contents = await Promise.all(
        assets.map((a) => this.fetchAsset(a.url, cacheDir))
      );

      const inlinedAssets = new Map<string, string>();
      assets.forEach((a, i) => inlinedAssets.set(a.url, contents[i]));

      onProgress?.({ stage: 'converting', message: 'Génération HTML offline...', progress: 70 });

      const html = getRevealJsHTML(options.content, options, inlinedAssets);
      const outputPath = options.outputPath || join(
        dirname(options.projectPath),
        `${options.metadata?.title || 'presentation'}-offline.html`
      );

      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, html, 'utf-8');

      onProgress?.({ stage: 'complete', message: 'Présentation offline créée!', progress: 100 });
      return { success: true, outputPath };
    } catch (error: any) {
      console.error('❌ Offline export failed:', error);
      return { success: false, error: error.message };
    }
  }

  // ─── PDF Export ────────────────────────────────────────────────────────────

  /**
   * Export to PDF via a hidden BrowserWindow with reveal.js ?print-pdf mode.
   */
  async exportToPDF(
    options: RevealJsExportOptions,
    onProgress?: (progress: RevealJsProgress) => void
  ): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    let win: BrowserWindow | null = null;
    const tmpHtml = join(tmpdir(), `cliodeck-pdf-export-${Date.now()}.html`);

    try {
      onProgress?.({ stage: 'preparing', message: 'Préparation HTML pour impression...', progress: 15 });

      // Inject print-pdf class so reveal.js renders all slides
      const html = getRevealJsHTML(options.content, options)
        .replace('<body>', '<body class="reveal-viewport">');
      const pdfHtml = html.replace(
        'Reveal.initialize(',
        'document.querySelector(".reveal").classList.add("print-pdf"); Reveal.initialize('
      );

      await writeFile(tmpHtml, pdfHtml, 'utf-8');

      onProgress?.({ stage: 'converting', message: 'Rendu de la présentation...', progress: 40 });

      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 960,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });

      await win.loadFile(tmpHtml);

      // Wait for reveal.js to finish rendering
      await new Promise<void>((resolve) => setTimeout(resolve, 2500));

      onProgress?.({ stage: 'converting', message: 'Génération du PDF...', progress: 70 });

      const pdfData = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: { width: 254000, height: 190500 }, // 254mm × 190.5mm (16:12 ≈ 16:9)
        landscape: true,
      });

      const outputPath = options.outputPath || join(
        dirname(options.projectPath),
        `${options.metadata?.title || 'presentation'}.pdf`
      );

      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, pdfData);

      onProgress?.({ stage: 'complete', message: 'PDF créé!', progress: 100 });
      return { success: true, outputPath };
    } catch (error: any) {
      console.error('❌ PDF export failed:', error);
      return { success: false, error: error.message };
    } finally {
      win?.close();
      // Clean up temp file (best-effort)
      writeFile(tmpHtml, '').catch(() => {});
    }
  }
}

export const revealJsExportService = new RevealJsExportService();
