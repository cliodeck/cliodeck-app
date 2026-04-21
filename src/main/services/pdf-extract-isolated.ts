/**
 * Isolated PDF extraction via child_process.fork().
 *
 * Wraps the heavy pdfjs-dist extraction in a separate Node process so that a
 * SIGSEGV inside pdfjs only kills the worker — not the Electron main process.
 *
 * Features:
 *  - 120 s timeout (large PDFs can be slow)
 *  - Crash detection (SIGSEGV / SIGABRT / non-zero exit)
 *  - Sequential queue (one extraction at a time to bound RAM)
 */

import { fork, type ChildProcess } from 'child_process';
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
  // In packaged app: resources/app.asar/dist/...
  // In dev: project root / dist/...
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  if (app.isPackaged) {
    // Inside asar: same relative structure
    return path.join(__dirname, '..', 'workers', 'pdf-extract-worker.js');
  }

  // Dev mode: compiled output lives under dist/
  // __dirname is dist/src/main/services/ → go up to dist/src/main/workers/
  return path.join(__dirname, '..', 'workers', 'pdf-extract-worker.js');
}

// ── Concurrency queue ───────────────────────────────────────────────────

let pending: Promise<IsolatedExtractionResult> = Promise.resolve({ ok: true, pages: [], metadata: { keywords: [] }, title: '' });

/**
 * Extract text from a PDF in an isolated child process.
 *
 * If the worker crashes (SIGSEGV, SIGABRT, non-zero exit), this returns a
 * failure result instead of throwing — callers can skip the file gracefully.
 */
export function extractPdfIsolated(filePath: string): Promise<IsolatedExtractionResult> {
  // Chain on the queue so only one extraction runs at a time
  const next = pending.then(
    () => doExtract(filePath),
    () => doExtract(filePath) // also continue after a prior rejection
  );
  pending = next;
  return next;
}

// ── Core fork logic ─────────────────────────────────────────────────────

const TIMEOUT_MS = 120_000; // 2 minutes

function doExtract(filePath: string): Promise<IsolatedExtractionResult> {
  return new Promise<IsolatedExtractionResult>((resolve) => {
    const workerPath = resolveWorkerPath();
    let child: ChildProcess;
    let settled = false;

    const settle = (result: IsolatedExtractionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Ensure the child is dead
      try {
        child?.kill();
      } catch {
        // already exited
      }
      resolve(result);
    };

    try {
      child = fork(workerPath, [], {
        // Pure Node — no Electron renderer deps
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      resolve({ ok: false, error: `Failed to spawn PDF worker: ${msg}` });
      return;
    }

    // Forward worker stdout/stderr to main-process console for debugging
    child.stdout?.on('data', (data: Buffer) => {
      process.stdout.write(`[pdf-worker] ${data.toString()}`);
    });
    child.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(`[pdf-worker:err] ${data.toString()}`);
    });

    // Timeout
    const timer = setTimeout(() => {
      console.error(`[pdf-extract-isolated] Timeout after ${TIMEOUT_MS / 1000}s for ${filePath}`);
      settle({
        ok: false,
        error: `PDF extraction timed out after ${TIMEOUT_MS / 1000}s — the file may be too large or corrupted`,
      });
    }, TIMEOUT_MS);

    // IPC messages from worker
    let readyReceived = false;
    child.on('message', (msg: Record<string, unknown>) => {
      if (!readyReceived && msg.ready) {
        readyReceived = true;
        // Worker is ready — send the extraction request
        child.send({ filePath });
        return;
      }
      // Extraction result
      if (msg.ok === true && !msg.ready) {
        settle(msg as unknown as IsolatedExtractionSuccess);
      } else if (msg.ok === false) {
        settle(msg as unknown as IsolatedExtractionFailure);
      }
    });

    // Worker crash / exit
    child.on('error', (err: Error) => {
      settle({ ok: false, error: `PDF worker error: ${err.message}` });
    });

    child.on('exit', (code: number | null, signal: string | null) => {
      if (signal) {
        settle({
          ok: false,
          error: `PDF extraction crashed (${signal}) — this PDF may contain unsupported elements`,
        });
      } else if (code !== null && code !== 0) {
        settle({
          ok: false,
          error: `PDF extraction failed (exit code ${code})`,
        });
      }
      // Normal exit (code 0) without a message means we already settled
    });
  });
}
