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

const getCdnAssets = (theme: string): CdnAsset[] => [
  { url: `${CDN_BASE}/dist/reset.css`, tag: 'style' },
  { url: `${CDN_BASE}/dist/reveal.css`, tag: 'style' },
  { url: `${CDN_BASE}/dist/theme/${theme}.css`, tag: 'style', attrs: 'id="theme"' },
  { url: `${CDN_BASE}/plugin/highlight/monokai.css`, tag: 'style' },
  { url: `${CDN_BASE}/dist/reveal.js`, tag: 'script' },
  { url: `${CDN_BASE}/plugin/notes/notes.js`, tag: 'script' },
  { url: `${CDN_BASE}/plugin/markdown/markdown.js`, tag: 'script' },
  { url: `${CDN_BASE}/plugin/highlight/highlight.js`, tag: 'script' },
  { url: `${CDN_BASE}/plugin/zoom/zoom.js`, tag: 'script' },
  { url: `${CDN_BASE}/plugin/search/search.js`, tag: 'script' },
  { url: `${CDN_BASE}/plugin/math/math.js`, tag: 'script' },
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

// MARK: - Templates

/**
 * Generates the full reveal.js HTML for a given markdown content and options.
 * Uses CDN by default. Pass inlinedAssets to get a fully offline HTML.
 */
export const generatePreviewHtml = (content: string, options: RevealJsExportOptions): string =>
  getRevealJsHTML(content, options);

const getRevealJsHTML = (content: string, options: RevealJsExportOptions, inlinedAssets?: Map<string, string>): string => {
  const config = options.config || {};
  const metadata = options.metadata || {};

  // Convert markdown to slides (split on --- and ## headers)
  const slides = content.split(/\n---\n/).map(slide => {
    // Check if slide has speaker notes (Note:)
    const noteMatch = slide.match(/\nNote:\s*(.+?)(?=\n##|\n---|$)/s);
    let slideContent = slide;
    let notes = '';

    if (noteMatch) {
      notes = noteMatch[1].trim();
      slideContent = slide.replace(/\nNote:\s*.+?(?=\n##|\n---|$)/s, '');
    }

    return {
      content: slideContent.trim(),
      notes: notes
    };
  });

  // Build slides HTML
  const slidesHTML = slides.map(slide => {
    if (!slide.content) return '';

    let html = `        <section data-markdown>\n          <textarea data-template>\n${slide.content}\n          </textarea>\n`;

    if (slide.notes) {
      html += `          <aside class="notes">\n${slide.notes}\n          </aside>\n`;
    }

    html += '        </section>';
    return html;
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

  // Build asset tags (CDN or inline)
  const theme = config.theme || 'black';
  const cdnAssets = getCdnAssets(theme);

  const assetTags = cdnAssets.map((asset) => {
    if (inlinedAssets?.has(asset.url)) {
      const content = inlinedAssets.get(asset.url)!;
      const attrsStr = asset.attrs ? ` ${asset.attrs}` : '';
      return asset.tag === 'style'
        ? `  <style${attrsStr}>\n${content}\n  </style>`
        : `  <script${attrsStr}>\n${content}\n  </script>`;
    }
    // Fall back to CDN
    const attrsStr = asset.attrs ? ` ${asset.attrs}` : '';
    return asset.tag === 'style'
      ? `  <link rel="stylesheet" href="${asset.url}"${attrsStr ? ' ' + attrsStr : ''}>`
      : `  <script src="${asset.url}"${attrsStr ? ' ' + attrsStr : ''}></script>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${metadata.title || 'Présentation'}</title>

${assetTags}

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

  <script>
    Reveal.initialize({
      ...${JSON.stringify(revealConfig, null, 2)
        .split('\n')
        .map((line, i) => i === 0 ? line : '      ' + line)
        .join('\n')},
      plugins: [
        RevealMarkdown,
        RevealHighlight,
        RevealNotes,
        RevealZoom,
        RevealSearch,
        RevealMath.KaTeX
      ]
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
      const assets = getCdnAssets(theme);

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
