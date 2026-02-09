/**
 * PDFConverter - Convert PDF pages to images using Poppler
 *
 * Directly uses system-installed Poppler utilities (pdftoppm/pdftocairo).
 * Requires Poppler to be installed on the system:
 * - macOS: brew install poppler
 * - Ubuntu: apt-get install poppler-utils
 * - Windows: Download from https://github.com/oschwartz10612/poppler-windows
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// MARK: - Types

export interface PDFPageImage {
  pageNumber: number;
  width: number;
  height: number;
  data: Buffer; // PNG image data
}

export interface PDFConversionOptions {
  /** Scale factor for rendering (default: 2.0 for good OCR quality) */
  scale?: number;
  /** Specific pages to convert (1-indexed), or undefined for all pages */
  pages?: number[];
  /** Output format (default: 'png') */
  format?: 'png';
  /** DPI for rendering (default: 300 for good OCR quality) */
  dpi?: number;
}

export interface PDFConversionResult {
  pageCount: number;
  pages: PDFPageImage[];
  tempDir?: string; // Directory where temp files were saved
}

// MARK: - PDFConverter

export class PDFConverter {
  private pdftoppmPath: string | null = null;
  private pdftocairoPath: string | null = null;
  private pdfinfoPath: string | null = null;
  private isInitialized: boolean = false;

  /**
   * Find Poppler binary in common locations
   */
  private findBinary(name: string): string | null {
    const searchPaths = [
      '/usr/local/bin',       // Intel Mac Homebrew
      '/opt/homebrew/bin',    // Apple Silicon Homebrew
      '/usr/bin',             // Linux system
      '/usr/local/bin',       // Linux local
    ];

    for (const searchPath of searchPaths) {
      const fullPath = path.join(searchPath, name);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }

    // Try to find via which command (fallback)
    try {
      const result = execSync(`which ${name}`, { encoding: 'utf8' }).trim();
      if (result && fs.existsSync(result)) {
        return result;
      }
    } catch {
      // which command failed, binary not in PATH
    }

    return null;
  }

  /**
   * Initialize - find Poppler binaries
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Find pdftoppm (preferred for PNG output)
    this.pdftoppmPath = this.findBinary('pdftoppm');
    this.pdftocairoPath = this.findBinary('pdftocairo');
    this.pdfinfoPath = this.findBinary('pdfinfo');

    if (!this.pdftoppmPath && !this.pdftocairoPath) {
      throw new Error(
        'Poppler utilities not found. Please install Poppler:\n' +
        '  macOS: brew install poppler\n' +
        '  Ubuntu: apt-get install poppler-utils\n' +
        '  Windows: Download from https://github.com/oschwartz10612/poppler-windows'
      );
    }

    const tool = this.pdftoppmPath ? 'pdftoppm' : 'pdftocairo';
    console.log(`📄 PDF converter initialized (using system ${tool})`);
    this.isInitialized = true;
  }

  /**
   * Check if a file is a PDF
   */
  isPDF(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.pdf';
  }

  /**
   * Get the number of pages in a PDF
   */
  async getPageCount(pdfPath: string): Promise<number> {
    await this.initialize();

    if (this.pdfinfoPath) {
      try {
        const { stdout } = await execFileAsync(this.pdfinfoPath, [pdfPath]);
        const match = stdout.match(/Pages:\s+(\d+)/);
        if (match) {
          return parseInt(match[1], 10);
        }
      } catch (error) {
        console.error('Failed to get PDF page count with pdfinfo:', error);
      }
    }

    // Fallback: convert to temp and count files
    const result = await this.convertToTempFiles(pdfPath);
    const count = result.files.length;
    this.cleanupTempFiles(result.tempDir);
    return count;
  }

  /**
   * Convert PDF pages to images
   * Returns image buffers that can be used for OCR
   */
  async convertToImages(
    pdfPath: string,
    options: PDFConversionOptions = {}
  ): Promise<PDFConversionResult> {
    // Convert to temp files first, then read into buffers
    const tempResult = await this.convertToTempFiles(pdfPath, options);

    const pages: PDFPageImage[] = [];
    for (let i = 0; i < tempResult.files.length; i++) {
      const filePath = tempResult.files[i];
      const data = fs.readFileSync(filePath);

      // Basic dimension extraction (we don't need exact dimensions for OCR)
      pages.push({
        pageNumber: i + 1,
        width: 0, // Could be extracted with image-size package if needed
        height: 0,
        data,
      });
    }

    // Keep temp files for cleanup by caller if needed
    return {
      pageCount: tempResult.pageCount,
      pages,
      tempDir: tempResult.tempDir,
    };
  }

  /**
   * Convert PDF to temporary image files using system Poppler
   */
  async convertToTempFiles(
    pdfPath: string,
    options: PDFConversionOptions = {}
  ): Promise<{ tempDir: string; files: string[]; pageCount: number }> {
    await this.initialize();

    const dpi = options.dpi || 300; // Good quality for OCR

    if (!fs.existsSync(pdfPath)) {
      throw new Error(`PDF not found: ${pdfPath}`);
    }

    console.log(`📄 Converting PDF: ${path.basename(pdfPath)} (dpi: ${dpi})`);

    // Create temp directory
    const tempDir = path.join(
      os.tmpdir(),
      `cliodeck-pdf-${Date.now()}`
    );
    fs.mkdirSync(tempDir, { recursive: true });

    // Output file prefix
    const outputPrefix = path.join(tempDir, 'page');

    try {
      // Use pdftoppm (preferred) or pdftocairo
      if (this.pdftoppmPath) {
        // pdftoppm args: -png -r <dpi> input.pdf output_prefix
        const args = ['-png', '-r', String(dpi), pdfPath, outputPrefix];
        await execFileAsync(this.pdftoppmPath, args, { maxBuffer: 50 * 1024 * 1024 });
      } else if (this.pdftocairoPath) {
        // pdftocairo args: -png -r <dpi> input.pdf output_prefix
        const args = ['-png', '-r', String(dpi), pdfPath, outputPrefix];
        await execFileAsync(this.pdftocairoPath, args, { maxBuffer: 50 * 1024 * 1024 });
      }

      // Find all generated files
      const files = fs.readdirSync(tempDir)
        .filter(f => f.endsWith('.png'))
        .sort((a, b) => {
          // Sort by page number (page-1.png, page-2.png, etc.)
          const numA = parseInt(a.match(/\d+/)?.[0] || '0');
          const numB = parseInt(b.match(/\d+/)?.[0] || '0');
          return numA - numB;
        })
        .map(f => path.join(tempDir, f));

      // Filter to specific pages if requested
      let filteredFiles = files;
      if (options.pages && options.pages.length > 0) {
        filteredFiles = options.pages
          .filter(p => p >= 1 && p <= files.length)
          .map(p => files[p - 1]);
      }

      console.log(`📁 Saved ${filteredFiles.length} page images to: ${tempDir}`);

      return {
        tempDir,
        files: filteredFiles,
        pageCount: files.length,
      };
    } catch (error: any) {
      // Clean up on error
      this.cleanupTempFiles(tempDir);

      // Check if it's a Poppler not found error
      if (error.code === 'ENOENT') {
        throw new Error(
          'Poppler utilities not found. Please install Poppler:\n' +
          '  macOS: brew install poppler\n' +
          '  Ubuntu: apt-get install poppler-utils\n' +
          '  Windows: Download from https://github.com/oschwartz10612/poppler-windows'
        );
      }

      throw new Error(`PDF conversion failed: ${error.message || error}`);
    }
  }

  /**
   * Clean up temporary files
   */
  cleanupTempFiles(tempDir: string): void {
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        fs.unlinkSync(path.join(tempDir, file));
      }
      fs.rmdirSync(tempDir);
      console.log(`🧹 Cleaned up temp directory: ${tempDir}`);
    }
  }
}

// MARK: - Factory

export function createPDFConverter(): PDFConverter {
  return new PDFConverter();
}
