import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

const getRevealJsHTML = (content: string, options: RevealJsExportOptions): string => {
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

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${metadata.title || 'Présentation'}</title>

  <!-- Reveal.js CSS -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.0.4/dist/reset.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.0.4/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.0.4/dist/theme/${config.theme || 'black'}.css">

  <!-- Theme used for syntax highlighting of code -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.0.4/plugin/highlight/monokai.css">

  <style>
    /* Custom styles */
    .reveal h1, .reveal h2, .reveal h3, .reveal h4, .reveal h5, .reveal h6 {
      text-transform: none;
    }

    .reveal section img {
      border: none;
      box-shadow: none;
      background: none;
    }

    /* Author and date */
    .reveal .author-info {
      margin-top: 2rem;
      font-size: 0.8em;
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <div class="reveal">
    <div class="slides">
${slidesHTML}
    </div>
  </div>

  <!-- Reveal.js -->
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.0.4/dist/reveal.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.0.4/plugin/notes/notes.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.0.4/plugin/markdown/markdown.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.0.4/plugin/highlight/highlight.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.0.4/plugin/zoom/zoom.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.0.4/plugin/search/search.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.0.4/plugin/math/math.js"></script>

  <script>
    // More info about initialization & config:
    // - https://revealjs.com/initialization/
    // - https://revealjs.com/config/
    Reveal.initialize(${JSON.stringify(revealConfig, null, 2)
      .split('\n')
      .map((line, i) => i === 0 ? line : '      ' + line)
      .join('\n')});

    Reveal.configure({
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
}

export const revealJsExportService = new RevealJsExportService();
