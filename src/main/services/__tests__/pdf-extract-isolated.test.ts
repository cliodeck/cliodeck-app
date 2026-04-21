/**
 * Tests for the isolated PDF extraction helper.
 *
 * These tests mock child_process.fork() to verify:
 *  1. Successful extraction passes through correctly
 *  2. Worker crashes (SIGSEGV) return a clean error, not a throw
 *  3. Timeout fires when the worker hangs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mock child_process and electron ─────────────────────────────────────

// We need to mock these before importing the module under test.

// Fake ChildProcess that we control
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  send = vi.fn();
  kill = vi.fn(() => { this.killed = true; });
}

let fakeChild: FakeChild;

vi.mock('child_process', () => ({
  fork: vi.fn(() => {
    fakeChild = new FakeChild();
    return fakeChild;
  }),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}));

// ── Import after mocks are set up ──────────────────────────────────────

// Dynamic import so the mocks are in place
const { extractPdfIsolated } = await import('../pdf-extract-isolated.js');

describe('extractPdfIsolated', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns extraction result on success', async () => {
    const promise = extractPdfIsolated('/fake/test.pdf');

    // Simulate worker ready + result
    await vi.advanceTimersByTimeAsync(0);
    fakeChild.emit('message', { ok: true, ready: true });

    // Verify send was called with filePath
    expect(fakeChild.send).toHaveBeenCalledWith({ filePath: '/fake/test.pdf' });

    // Simulate successful response
    fakeChild.emit('message', {
      ok: true,
      pages: [{ pageNumber: 1, text: 'Hello world' }],
      metadata: { keywords: [] },
      title: 'Test PDF',
    });

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
    fakeChild.emit('message', { ok: true, ready: true });

    // Simulate SIGSEGV crash
    fakeChild.emit('exit', null, 'SIGSEGV');

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
    fakeChild.emit('message', { ok: true, ready: true });

    // Simulate non-zero exit
    fakeChild.emit('exit', 1, null);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('exit code 1');
    }
  });

  it('returns error on timeout', async () => {
    const promise = extractPdfIsolated('/fake/slow.pdf');

    await vi.advanceTimersByTimeAsync(0);
    fakeChild.emit('message', { ok: true, ready: true });

    // Advance past the 120s timeout
    await vi.advanceTimersByTimeAsync(121_000);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('timed out');
    }
  });

  it('returns error when worker sends an error message', async () => {
    const promise = extractPdfIsolated('/fake/bad.pdf');

    await vi.advanceTimersByTimeAsync(0);
    fakeChild.emit('message', { ok: true, ready: true });

    // Worker reports an error
    fakeChild.emit('message', { ok: false, error: 'File not found' });

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('File not found');
    }
  });
});
