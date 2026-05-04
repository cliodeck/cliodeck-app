/**
 * Isolated PDF extraction via child_process.spawn() with SYSTEM Node.
 *
 * Electron 28 ships Node 18.18 which causes pdfjs-dist to SIGSEGV on
 * require(). The system Node (v20+) doesn't have this issue. We spawn
 * the worker with the system `node` binary and communicate via
 * stdin (JSON request) → stdout (JSON response).
 *
 * Features:
 *  - 120 s timeout (large PDFs can be slow)
 *  - Crash detection (SIGSEGV / SIGABRT / non-zero exit)
 *  - Sequential queue (one extraction at a time to bound RAM)
 */

import { spawn } from 'child_process';
import path from 'path';
import { app } from 'electron';
import type { DocumentPage, PDFMetadata } from '../../../backend/types/pdf-document.js';
import { fileURLToPath } from 'url';

// ── Public types ────────────────────────────────────────────────────────

export interface IsolatedExtractionSuccess {
  ok: true;
  pages: DocumentPage[];
  metadata: PDFMetadata;
  title: string;
}

export interface IsolatedExtractionFailure {
  ok: false;
  error: string;
}

export type IsolatedExtractionResult = IsolatedExtractionSuccess | IsolatedExtractionFailure;

// ── Worker path resolution ──────────────────────────────────────────────

function resolveWorkerPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const workerPath = path.join(__dirname, '..', 'workers', 'pdf-extract-worker.js');

  if (app.isPackaged) {
    // System node can't read app.asar (Electron-only virtual FS). The worker
    // and pdfjs-dist must be in `asarUnpack` so they live on the real disk.
    return workerPath.replace(
      `${path.sep}app.asar${path.sep}`,
      `${path.sep}app.asar.unpacked${path.sep}`,
    );
  }
  return workerPath;
}

/**
 * Find the system Node binary. In dev, `node` from PATH is fine.
 * In packaged mode, we look for common locations.
 */
function resolveNodeBinary(): string {
  // Prefer the system node, not Electron's embedded one
  if (process.platform === 'win32') return 'node.exe';
  // On unix, /usr/bin/node or /usr/local/bin/node; let PATH resolve it
  return 'node';
}

// ── Concurrency queue ───────────────────────────────────────────────────

let pending: Promise<IsolatedExtractionResult> = Promise.resolve({
  ok: true, pages: [], metadata: { keywords: [] }, title: '',
});

/**
 * Extract text from a PDF in an isolated child process using the system Node.
 */
export function extractPdfIsolated(filePath: string): Promise<IsolatedExtractionResult> {
  const next = pending.then(
    () => doExtract(filePath),
    () => doExtract(filePath),
  );
  pending = next;
  return next;
}

// ── Core spawn logic ────────────────────────────────────────────────────

const TIMEOUT_MS = 120_000;

function doExtract(filePath: string): Promise<IsolatedExtractionResult> {
  return new Promise<IsolatedExtractionResult>((resolve) => {
    const workerPath = resolveWorkerPath();
    const nodeBin = resolveNodeBinary();
    let settled = false;

    const settle = (result: IsolatedExtractionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* already exited */ }
      resolve(result);
    };

    // Spawn with system Node, passing the worker script.
    // Remove ELECTRON_RUN_AS_NODE to use real system node, not Electron's.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    const child = spawn(nodeBin, [workerPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Detach not needed — we want the child to die with us
    });

    // Send the request as a JSON line on stdin, then close stdin
    child.stdin.write(JSON.stringify({ filePath }) + '\n');
    child.stdin.end();

    // Accumulate stdout for the JSON response
    let stdoutBuf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
    });

    // Forward stderr for debugging
    child.stderr.on('data', (chunk: Buffer) => {
      // Only log non-warning lines (pdfjs spams warnings about fonts)
      const text = chunk.toString('utf8');
      if (!text.startsWith('Warning:')) {
        process.stderr.write(`[pdf-worker:err] ${text}`);
      }
    });

    const timer = setTimeout(() => {
      console.error(`[pdf-extract-isolated] Timeout after ${TIMEOUT_MS / 1000}s for ${filePath}`);
      settle({
        ok: false,
        error: `PDF extraction timed out after ${TIMEOUT_MS / 1000}s`,
      });
    }, TIMEOUT_MS);

    child.on('error', (err: Error) => {
      settle({ ok: false, error: `PDF worker spawn error: ${err.message}` });
    });

    child.on('close', (code: number | null, signal: string | null) => {
      if (signal) {
        settle({
          ok: false,
          error: `PDF extraction crashed (${signal}) — this PDF may contain unsupported elements`,
        });
        return;
      }

      // Try to parse the JSON from stdout
      try {
        const result = JSON.parse(stdoutBuf.trim());
        if (result.ok === true) {
          settle(result as IsolatedExtractionSuccess);
        } else {
          settle({ ok: false, error: result.error || 'Unknown worker error' });
        }
      } catch {
        if (code !== 0) {
          settle({ ok: false, error: `PDF extraction failed (exit code ${code})` });
        } else {
          settle({ ok: false, error: 'PDF worker returned unparseable output' });
        }
      }
    });
  });
}
