/**
 * Tests for the security-events JSONL reader / aggregator (fusion 2.8).
 *
 * Two layers:
 *   - `readSecurityEventsLog` parses a JSONL file, fails soft on
 *     malformed lines, and returns [] for missing files.
 *   - `aggregateSecurityEvents` produces the stats shape the renderer
 *     consumes, preserving total / byKind / bySeverity / range / recent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readSecurityEventsLog,
  aggregateSecurityEvents,
} from '../events-reader.js';
import type { SecurityEvent } from '../events.js';

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-events-test-'));
  logPath = path.join(tmpDir, 'security-events.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeEvents(events: SecurityEvent[]): void {
  fs.writeFileSync(
    logPath,
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8'
  );
}

const sourceA = 'pdf-chunk:doc-a/c-a';

describe('readSecurityEventsLog', () => {
  it('returns [] when the file does not exist (fresh workspace)', async () => {
    const out = await readSecurityEventsLog(
      path.join(tmpDir, 'never-written.jsonl')
    );
    expect(out).toEqual([]);
  });

  it('parses a small log of mixed event kinds', async () => {
    writeEvents([
      {
        kind: 'suspicious_instruction',
        source: sourceA,
        chunkId: 'c1',
        pattern: 'ignore previous',
        severity: 'high',
        at: '2026-04-01T10:00:00Z',
      },
      {
        kind: 'external_url',
        source: sourceA,
        chunkId: 'c1',
        url: 'https://example.org',
        at: '2026-04-01T10:00:01Z',
      },
    ]);
    const events = await readSecurityEventsLog(logPath);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('suspicious_instruction');
    expect(events[1].kind).toBe('external_url');
  });

  it('skips malformed lines without poisoning the rest', async () => {
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({
          kind: 'unusual_encoding',
          source: sourceA,
          chunkId: 'c1',
          detail: 'zero-width run',
          severity: 'medium',
          at: '2026-04-02T10:00:00Z',
        }),
        '{ this is not json',
        '',
        // Missing `kind` discriminant — defensive filter rejects.
        '{"foo": "bar", "at": "2026-04-02T10:00:01Z"}',
        JSON.stringify({
          kind: 'prompt_injection_blocked',
          source: sourceA,
          chunkId: 'c2',
          mode: 'block',
          pattern: 'reveal system prompt',
          severity: 'high',
          at: '2026-04-02T10:00:02Z',
        }),
      ].join('\n'),
      'utf8'
    );
    const events = await readSecurityEventsLog(logPath);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.kind)).toEqual([
      'unusual_encoding',
      'prompt_injection_blocked',
    ]);
  });

  it('honours a numeric `limit` by keeping the tail', async () => {
    const many: SecurityEvent[] = Array.from({ length: 5 }, (_, i) => ({
      kind: 'external_url' as const,
      source: sourceA,
      chunkId: `c${i}`,
      url: `https://e${i}`,
      at: `2026-04-03T10:00:0${i}Z`,
    }));
    writeEvents(many);
    const last3 = await readSecurityEventsLog(logPath, { limit: 3 });
    expect(last3).toHaveLength(3);
    expect(last3[0].chunkId).toBe('c2');
    expect(last3[2].chunkId).toBe('c4');
  });
});

describe('aggregateSecurityEvents', () => {
  const events: SecurityEvent[] = [
    {
      kind: 'suspicious_instruction',
      source: sourceA,
      chunkId: 'c1',
      pattern: 'ignore previous',
      severity: 'high',
      at: '2026-04-10T08:00:00Z',
    },
    {
      kind: 'suspicious_instruction',
      source: sourceA,
      chunkId: 'c2',
      pattern: 'reveal system prompt',
      severity: 'medium',
      at: '2026-04-10T09:00:00Z',
    },
    {
      kind: 'external_url',
      source: sourceA,
      chunkId: 'c3',
      url: 'https://x',
      at: '2026-04-09T08:00:00Z',
    },
    {
      kind: 'unusual_encoding',
      source: sourceA,
      chunkId: 'c4',
      detail: 'long base64',
      severity: 'low',
      at: '2026-04-10T07:00:00Z',
    },
    {
      kind: 'prompt_injection_blocked',
      source: sourceA,
      chunkId: 'c5',
      mode: 'audit',
      pattern: 'jailbreak',
      severity: 'high',
      at: '2026-04-10T10:00:00Z',
    },
  ];

  it('totals events and counts by kind', () => {
    const stats = aggregateSecurityEvents(events);
    expect(stats.total).toBe(5);
    expect(stats.byKind).toEqual({
      suspicious_instruction: 2,
      external_url: 1,
      unusual_encoding: 1,
      prompt_injection_blocked: 1,
    });
  });

  it('counts severity across kinds, ignoring events that lack severity (external_url)', () => {
    const stats = aggregateSecurityEvents(events);
    expect(stats.bySeverity).toEqual({ low: 1, medium: 1, high: 2 });
    // Sanity: external_url is the only kind without severity, so 5 - 4 = 1.
    expect(
      stats.total -
        (stats.bySeverity.low + stats.bySeverity.medium + stats.bySeverity.high)
    ).toBe(1);
  });

  it('exposes the inclusive timestamp range', () => {
    const stats = aggregateSecurityEvents(events);
    expect(stats.firstAt).toBe('2026-04-09T08:00:00Z');
    expect(stats.lastAt).toBe('2026-04-10T10:00:00Z');
  });

  it('returns the most recent events first, capped by recentLimit', () => {
    const stats = aggregateSecurityEvents(events, { recentLimit: 2 });
    expect(stats.recent).toHaveLength(2);
    expect(stats.recent[0].chunkId).toBe('c5'); // 10:00
    expect(stats.recent[1].chunkId).toBe('c2'); // 09:00
  });

  it('returns zeros for an empty input', () => {
    const stats = aggregateSecurityEvents([]);
    expect(stats.total).toBe(0);
    expect(stats.byKind.suspicious_instruction).toBe(0);
    expect(stats.bySeverity.high).toBe(0);
    expect(stats.firstAt).toBeUndefined();
    expect(stats.lastAt).toBeUndefined();
    expect(stats.recent).toEqual([]);
  });
});
