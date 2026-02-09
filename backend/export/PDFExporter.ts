import * as fs from 'fs';
import * as path from 'path';
import { marked } from 'marked';

// Lazy-load Puppeteer only when needed (saves ~400MB on startup)
let puppeteerInstance: typeof import('puppeteer') | null = null;
async function getPuppeteer() {
  if (!puppeteerInstance) {
    console.log('📦 Lazy-loading Puppeteer (~400MB)...');
    puppeteerInstance = await import('puppeteer');
    console.log('✅ Puppeteer loaded');
  }
  return puppeteerInstance;
}

export interface PDFExportOptions {
  format?: 'A4' | 'Letter';
  margin?: {
    top?: string;
    right?: string;
    bottom?: string;
    left?: string;
  };
  headerTemplate?: string;
  footerTemplate?: string;
  displayHeaderFooter?: boolean;
  printBackground?: boolean;
  landscape?: boolean;
}

export class PDFExporter {
  /**
   * Exporte du markdown en PDF
   */
  async exportToPDF(
    markdown: string,
    outputPath: string,
    options?: PDFExportOptions
  ): Promise<void> {
    // Convertir markdown en HTML
    const html = this.markdownToHTML(markdown);

    // Lazy-load Puppeteer (only loaded when export is triggered)
    const puppeteer = await getPuppeteer();

    // Lancer Puppeteer
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();

      // Charger le HTML
      await page.setContent(html, { waitUntil: 'networkidle0' });

      // Générer le PDF
      await page.pdf({
        path: outputPath,
        format: options?.format || 'A4',
        margin: options?.margin || {
          top: '2.5cm',
          right: '2.5cm',
          bottom: '2.5cm',
          left: '2.5cm',
        },
        displayHeaderFooter: options?.displayHeaderFooter ?? true,
        headerTemplate: options?.headerTemplate || this.defaultHeaderTemplate(),
        footerTemplate: options?.footerTemplate || this.defaultFooterTemplate(),
        printBackground: options?.printBackground ?? true,
        landscape: options?.landscape ?? false,
      });

      console.log(`✅ PDF exporté: ${outputPath}`);
    } finally {
      await browser.close();
    }
  }

  /**
   * Convertit markdown en HTML avec style académique
   */
  private markdownToHTML(markdown: string): string {
    // Configurer marked
    marked.setOptions({
      breaks: true,
      gfm: true,
    });

    // Parser le markdown
    const content = marked.parse(markdown);

    // Construire le HTML complet avec styles
    return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Document</title>
  <style>
    ${this.getAcademicStyles()}
  </style>
</head>
<body>
  <div class="document">
    ${content}
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Styles CSS académiques
   */
  private getAcademicStyles(): string {
    return `
      @page {
        margin: 0;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 0;
        font-family: 'Georgia', 'Times New Roman', serif;
        font-size: 12pt;
        line-height: 1.6;
        color: #000;
        background: #fff;
      }

      .document {
        max-width: 100%;
        margin: 0 auto;
      }

      /* Headings */
      h1 {
        font-size: 20pt;
        font-weight: bold;
        margin: 24pt 0 12pt 0;
        page-break-after: avoid;
        text-align: center;
      }

      h2 {
        font-size: 16pt;
        font-weight: bold;
        margin: 18pt 0 10pt 0;
        page-break-after: avoid;
      }

      h3 {
        font-size: 14pt;
        font-weight: bold;
        margin: 14pt 0 8pt 0;
        page-break-after: avoid;
      }

      h4, h5, h6 {
        font-size: 12pt;
        font-weight: bold;
        margin: 12pt 0 6pt 0;
        page-break-after: avoid;
      }

      /* Paragraphs */
      p {
        margin: 0 0 12pt 0;
        text-align: justify;
        text-indent: 1.5em;
        orphans: 3;
        widows: 3;
      }

      p:first-child {
        text-indent: 0;
      }

      /* Lists */
      ul, ol {
        margin: 0 0 12pt 0;
        padding-left: 2em;
      }

      li {
        margin: 6pt 0;
      }

      /* Blockquotes */
      blockquote {
        margin: 12pt 0 12pt 2em;
        padding-left: 1em;
        border-left: 3px solid #ccc;
        font-style: italic;
        color: #555;
      }

      /* Code */
      code {
        font-family: 'Courier New', monospace;
        font-size: 10pt;
        background-color: #f5f5f5;
        padding: 2pt 4pt;
        border-radius: 3pt;
      }

      pre {
        margin: 12pt 0;
        padding: 12pt;
        background-color: #f5f5f5;
        border-radius: 6pt;
        overflow-x: auto;
        font-family: 'Courier New', monospace;
        font-size: 10pt;
        line-height: 1.4;
      }

      pre code {
        background: none;
        padding: 0;
      }

      /* Links */
      a {
        color: #0066cc;
        text-decoration: none;
      }

      a:hover {
        text-decoration: underline;
      }

      /* Tables */
      table {
        width: 100%;
        border-collapse: collapse;
        margin: 12pt 0;
        page-break-inside: avoid;
      }

      th, td {
        border: 1pt solid #000;
        padding: 6pt 8pt;
        text-align: left;
      }

      th {
        background-color: #f0f0f0;
        font-weight: bold;
      }

      /* Images */
      img {
        max-width: 100%;
        height: auto;
        display: block;
        margin: 12pt auto;
        page-break-inside: avoid;
      }

      /* Horizontal Rule */
      hr {
        border: none;
        border-top: 1pt solid #ccc;
        margin: 24pt 0;
      }

      /* Page breaks */
      .page-break {
        page-break-after: always;
      }

      /* Citations académiques */
      .citation {
        color: #0066cc;
        font-weight: 500;
      }

      /* Footnotes */
      .footnote {
        font-size: 10pt;
        vertical-align: super;
      }
    `;
  }

  /**
   * Template de header par défaut
   */
  private defaultHeaderTemplate(): string {
    return `
      <div style="font-size: 9pt; text-align: center; width: 100%; margin: 0 1cm;">
        <span class="title"></span>
      </div>
    `;
  }

  /**
   * Template de footer par défaut (numéro de page)
   */
  private defaultFooterTemplate(): string {
    return `
      <div style="font-size: 9pt; text-align: center; width: 100%; margin: 0 1cm;">
        <span class="pageNumber"></span> / <span class="totalPages"></span>
      </div>
    `;
  }

  /**
   * Exporte avec citations BibTeX resolues
   */
  async exportWithCitations(
    markdown: string,
    bibliographyPath: string,
    outputPath: string,
    options?: PDFExportOptions
  ): Promise<void> {
    // TODO: Implémenter la résolution des citations [@key]
    // Pour l'instant, export simple
    await this.exportToPDF(markdown, outputPath, options);
  }
}
