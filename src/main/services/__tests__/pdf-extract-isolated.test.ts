/**
 * Tests for the isolated PDF extraction helper.
 *
 * The helper spawns a child process with system Node (not Electron),
 * sends the filePath as a JSON line on stdin, and reads the worker's
 * JSON response from stdout. These tests mock child_process.spawn to
 * verify:
 *  1. Successful extraction passes through correctly
 *  2. Worker crashes (SIGSEGV) return a clean error, not a throw
 *  3. Non-zero exit codes surface an error
 *  4. Timeout fires when the worker hangs
 *  5. A worker-emitted {ok:false, error} is forwarded
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Fake spawned process: stdin is a writable stub, stdout/stderr are
// emitters we drive from the test, and the process itself emits
// 'close'/'error' like a real ChildProcess.
class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = vi.fn(() => { this.killed = true; });
}

let fakeChild: FakeChild;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    fakeChild = new FakeChild();
    return fakeChild;
  }),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}));

// Dynamic import so the mocks are in place before the module loads.
const { extractPdfIsolated } = await import('../pdf-extract-isolated.js');

// Helper: emit a full JSON payload on stdout as if the worker wrote it.
const emitStdoutJson = (payload: unknown): void => {
  fakeChild.stdout.emit('data', Buffer.from(JSON.stringify(payload) + '\n', 'utf8'));
};

describe('extractPdfIsolated', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns extraction result on success', async () => {
    const promise = extractPdfIsolated('/fake/test.pdf');
    await vi.advanceTimersByTimeAsync(0);

    // Verify the filePath was written to stdin as a JSON line.
    expect(fakeChild.stdin.write).toHaveBeenCalledWith(
      JSON.stringify({ filePath: '/fake/test.pdf' }) + '\n'
    );
    expect(fakeChild.stdin.end).toHaveBeenCalled();

    emitStdoutJson({
      ok: true,
      pages: [{ pageNumber: 1, text: 'Hello world' }],
      metadata: { keywords: [] },
      title: 'Test PDF',
    });
    fakeChild.emit('close', 0, null);

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].text).toBe('Hello world');
      expect(result.title).toBe('Test PDF');
    }
  });

  it('returns error when worker crashes with SIGSEGV', async () => {
    const promise = extractPdfIsolated('/fake/crash.pdf');
    await vi.advanceTimersByTimeAsync(0);

    fakeChild.emit('close', null, 'SIGSEGV');

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('SIGSEGV');
      expect(result.error).toContain('unsupported elements');
    }
  });

  it('returns error when worker exits with non-zero code', async () => {
    const promise = extractPdfIsolated('/fake/error.pdf');
    await vi.advanceTimersByTimeAsync(0);

    // No JSON on stdout, close with a non-zero exit.
    fakeChild.emit('close', 1, null);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('exit code 1');
    }
  });

  it('returns error on timeout', async () => {
    const promise = extractPdfIsolated('/fake/slow.pdf');
    await vi.advanceTimersByTimeAsync(0);

    // Advance past the 120 s timeout; don't emit anything on stdout or close.
    await vi.advanceTimersByTimeAsync(121_000);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('timed out');
    }
    expect(fakeChild.kill).toHaveBeenCalled();
  });

  it('forwards a worker-emitted error message', async () => {
    const promise = extractPdfIsolated('/fake/bad.pdf');
    await vi.advanceTimersByTimeAsync(0);

    emitStdoutJson({ ok: false, error: 'File not found' });
    fakeChild.emit('close', 0, null);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('File not found');
    }
  });
});
