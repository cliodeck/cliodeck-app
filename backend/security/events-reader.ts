/**
 * Reader / aggregator for `security-events.jsonl` (fusion 2.8).
 *
 * The file is one JSONL line per `SecurityEvent` (see `events.ts` for
 * the discriminated union). Lines are appended best-effort and may be
 * truncated on crash, so the parser is **fail-soft**: malformed lines
 * are skipped silently, the rest are still surfaced. Aggregation runs
 * on the parsed array — keeping the parse + aggregate split lets tests
 * exercise each layer independently.
 *
 * Typical workspace size is small (dozens to a few hundred events),
 * so the implementation is simple `readFile` + `split('\n')`. Files
 * older than that won't be a problem for v1; rotation lands later
 * (Phase 3.14) and we can stream from the tail when it does.
 */

import fs from 'fs/promises';
import type {
  SecurityEvent,
  SecurityEventKind,
  SecuritySeverity,
} from './events.js';

export interface SecurityEventStats {
  /** Total non-malformed events parsed. */
  total: number;
  /** Counts by `kind` (every kind appears, zero when absent). */
  byKind: Record<SecurityEventKind, number>;
  /** Counts by `severity`. Events without a severity field are ignored
   *  here (only `external_url` lacks one); their total is exposed via
   *  `total - sum(bySeverity)` if the caller wants it. */
  bySeverity: Record<SecuritySeverity, number>;
  /** Inclusive range of timestamps (ISO strings), undefined when empty. */
  firstAt?: string;
  lastAt?: string;
  /** Most recent N events, newest first. Caller chooses N via the
   *  reader's `limit`; the aggregator just preserves the order. */
  recent: SecurityEvent[];
}

const DEFAULT_RECENT_LIMIT = 50;

/**
 * Read and parse the JSONL file at `logPath`. Missing file returns an
 * empty array — the caller can render a "no events yet" empty state.
 * Optional `limit` keeps only the most recent N (head of file is read
 * regardless; cheap because v1 files are small).
 */
export async function readSecurityEventsLog(
  logPath: string,
  opts: { limit?: number } = {}
): Promise<SecurityEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(logPath, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw e;
  }
  const events: SecurityEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SecurityEvent;
      // Defensive: at least require the `kind` and `at` discriminants
      // so a stray JSON payload of the wrong shape doesn't poison
      // downstream aggregation.
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { kind?: unknown }).kind === 'string' &&
        typeof (parsed as { at?: unknown }).at === 'string'
      ) {
        events.push(parsed);
      }
    } catch {
      // Skip malformed line — appendFile crashed mid-write or the user
      // hand-edited the log. Either way, dropping the line is safer
      // than poisoning the aggregator.
    }
  }
  if (typeof opts.limit === 'number' && opts.limit >= 0) {
    return events.slice(-opts.limit);
  }
  return events;
}

/**
 * Aggregate a parsed event list into the shape the renderer's stats
 * panel consumes. Pure function — exposed separately for testing.
 */
export function aggregateSecurityEvents(
  events: readonly SecurityEvent[],
  opts: { recentLimit?: number } = {}
): SecurityEventStats {
  const recentLimit = opts.recentLimit ?? DEFAULT_RECENT_LIMIT;
  const byKind: Record<SecurityEventKind, number> = {
    suspicious_instruction: 0,
    external_url: 0,
    unusual_encoding: 0,
    prompt_injection_blocked: 0,
  };
  const bySeverity: Record<SecuritySeverity, number> = {
    low: 0,
    medium: 0,
    high: 0,
  };
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  for (const e of events) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    if ('severity' in e) {
      bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
    }
    if (firstAt === undefined || e.at < firstAt) firstAt = e.at;
    if (lastAt === undefined || e.at > lastAt) lastAt = e.at;
  }
  const sorted = [...events].sort((a, b) => (a.at < b.at ? 1 : -1));
  return {
    total: events.length,
    byKind,
    bySeverity,
    firstAt,
    lastAt,
    recent: sorted.slice(0, recentLimit),
  };
}
