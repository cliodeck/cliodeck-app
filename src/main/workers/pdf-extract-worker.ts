/**
 * Isolated PDF extraction worker.
 *
 * Runs in a child_process.fork() so that a pdfjs-dist SIGSEGV only kills this
 * worker, not the entire Electron app.
 *
 * Protocol (IPC via process.send / process.on('message')):
 *   Parent  -> Worker : { filePath: string }
 *   Worker  -> Parent : { ok: true, pages, metadata, title }
 *                      | { ok: false, error: string }
 *
 * IMPORTANT: This module must NOT import anything from Electron.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

// Redirect console.log/warn to stderr so stdout stays clean for our JSON.
// pdfjs-dist emits "Warning: ..." via console.warn which would corrupt the
// JSON response the parent reads from stdout.
console.log = (...args: unknown[]) => process.stderr.write(args.join(' ') + '\n');
console.warn = (...args: unknown[]) => process.stderr.write(args.join(' ') + '\n');

// ── Types (duplicated to avoid importing Electron-side modules) ─────────

interface DocumentPage {
  pageNumber: number;
  text: string;
}

interface PDFMetadata {
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  creationDate?: string; // serialised as ISO string for IPC
  modificationDate?: string;
  [key: string]: unknown;
}

interface WorkerRequest {
  filePath: string;
}

interface WorkerSuccessResponse {
  ok: true;
  pages: DocumentPage[];
  metadata: PDFMetadata;
  title: string;
}

interface WorkerErrorResponse {
  ok: false;
  error: string;
}


// ── pdfjs-dist bootstrap (same technique as PDFExtractor.ts) ────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pdfjsLib: any = null;
let canvasStubbed = false;

const mockCanvas = {
  createCanvas: (w: number, h: number) => ({
    getContext: () => ({
      fillRect: () => {},
      drawImage: () => {},
      getImageData: () => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      putImageData: () => {},
      createImageData: (w2: number, h2: number) => ({
        data: new Uint8ClampedArray(w2 * h2 * 4),
        width: w2,
        height: h2,
      }),
      save: () => {},
      restore: () => {},
      transform: () => {},
      setTransform: () => {},
      resetTransform: () => {},
      scale: () => {},
      translate: () => {},
      rotate: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      bezierCurveTo: () => {},
      quadraticCurveTo: () => {},
      stroke: () => {},
      fill: () => {},
      clip: () => {},
      rect: () => {},
      arc: () => {},
      ellipse: () => {},
      measureText: () => ({ width: 0 }),
      fillText: () => {},
      strokeText: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createPattern: () => null,
      clearRect: () => {},
      canvas: { width: w, height: h },
    }),
    width: w,
    height: h,
    toBuffer: () => Buffer.alloc(0),
    toDataURL: () => '',
  }),
  Image: class MockImage {
    width = 0;
    height = 0;
    src = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
  },
  loadImage: async () => ({ width: 0, height: 0 }),
};

function stubCanvas(): void {
  if (canvasStubbed) return;
  try {
    const req = createRequire(import.meta.url);
    const canvasPath = req.resolve('canvas');
    // @ts-expect-error require.cache typing incomplete for ESM createRequire
    req.cache[canvasPath] = {
      id: canvasPath,
      filename: canvasPath,
      loaded: true,
      exports: mockCanvas,
      parent: null,
      children: [],
      path: path.dirname(canvasPath),
      paths: [],
    };
    canvasStubbed = true;
  } catch {
    // canvas module not installed — nothing to stub
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function initPdfjs(): Promise<any> {
  if (pdfjsLib) return pdfjsLib;
  stubCanvas();
  const req = createRequire(import.meta.url);
  pdfjsLib = req('pdfjs-dist/legacy/build/pdf.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '';
  return pdfjsLib;
}

// ── PDF date parser ─────────────────────────────────────────────────────

function parsePDFDate(dateString: string): string | undefined {
  try {
    const match = dateString.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!match) return undefined;
    const [, year, month, day, hour, minute, second] = match;
    return new Date(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hour),
      parseInt(minute),
      parseInt(second)
    ).toISOString();
  } catch {
    return undefined;
  }
}

// ── Extraction logic ────────────────────────────────────────────────────

async function extractDocument(
  filePath: string
): Promise<{ pages: DocumentPage[]; metadata: PDFMetadata; title: string }> {
  const pdfjs = await initPdfjs();

  if (!fs.existsSync(filePath)) {
    throw new Error(`PDF file not found: ${filePath}`);
  }

  const fileBuffer = fs.readFileSync(filePath);
  const data = new Uint8Array(fileBuffer);
  const loadingTask = pdfjs.getDocument({ data });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfDocument: any = await loadingTask.promise;

  // Metadata
  let metadata: PDFMetadata = { keywords: [] };
  try {
    const meta = await pdfDocument.getMetadata();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info: any = meta.info || {};
    metadata = {
      subject: info.Subject || undefined,
      keywords: info.Keywords
        ? info.Keywords.split(',')
            .map((k: string) => k.trim())
            .filter((k: string) => k.length > 0)
        : [],
      creator: info.Creator || undefined,
      producer: info.Producer || undefined,
      creationDate: info.CreationDate ? parsePDFDate(info.CreationDate) : undefined,
      modificationDate: info.ModDate ? parsePDFDate(info.ModDate) : undefined,
    };
  } catch {
    // metadata extraction is best-effort
  }

  // Title
  let title = '';
  try {
    const meta = await pdfDocument.getMetadata();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info: any = meta.info || {};
    if (info.Title && info.Title.trim().length > 0) {
      title = info.Title.trim();
    } else {
      const firstPage = await pdfDocument.getPage(1);
      const textContent = await firstPage.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pageText = textContent.items.map((item: any) => item.str).join('\n');
      const lines = pageText.split('\n').map((l: string) => l.trim());
      for (const line of lines) {
        if (line.length > 10 && line.length < 200) {
          title = line;
          break;
        }
      }
    }
  } catch {
    // fall through to filename
  }
  if (!title) {
    title = path.basename(filePath, path.extname(filePath))
      .replace(/\.pdf$/i, '')
      .replace(/_/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Pages
  const pages: DocumentPage[] = [];
  for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
    const page = await pdfDocument.getPage(pageNum);
    const textContent = await page.getTextContent();
    const text = textContent.items
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((item: any) => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    pages.push({ pageNumber: pageNum, text });
  }

  return { pages, metadata, title };
}

// ── stdin/stdout protocol ───────────────────────────────────────────────
// Parent sends a JSON line on stdin: { filePath: string }
// Worker writes a JSON line on stdout: { ok, pages?, metadata?, title?, error? }
// stderr is for debug/warnings only.

let inputBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => { inputBuf += chunk; });
/**
 * Write a payload to stdout and exit with `code` only AFTER the write has
 * actually been flushed.
 *
 * `process.exit()` is synchronous: it kills the process without waiting for
 * the internal Writable buffer to drain. For payloads larger than the kernel
 * pipe buffer (~64 KB on macOS / Linux) Node will buffer the tail internally
 * and only flush it on the event loop's next tick; an immediate `process.exit`
 * after `stdout.write` therefore truncates the response. The parent then sees
 * a partial JSON string ending mid-token and bails out with
 * "PDF worker returned unparseable output".
 *
 * Honouring the write callback ensures every byte hits the pipe before we
 * exit. Belt-and-braces: drain the stream if it's still backpressured.
 */
function writeAndExit(payload: string, code: number): void {
  const flushed = process.stdout.write(payload, () => process.exit(code));
  if (!flushed) {
    process.stdout.once('drain', () => process.exit(code));
  }
}

process.stdin.on('end', async () => {
  let msg: WorkerRequest;
  try {
    msg = JSON.parse(inputBuf.trim());
  } catch {
    const response: WorkerErrorResponse = { ok: false, error: 'Invalid JSON on stdin' };
    writeAndExit(JSON.stringify(response) + '\n', 1);
    return;
  }

  try {
    const result = await extractDocument(msg.filePath);
    const response: WorkerSuccessResponse = {
      ok: true,
      pages: result.pages,
      metadata: result.metadata,
      title: result.title,
    };
    writeAndExit(JSON.stringify(response) + '\n', 0);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const response: WorkerErrorResponse = { ok: false, error: errorMsg };
    writeAndExit(JSON.stringify(response) + '\n', 1);
  }
});
