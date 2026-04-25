/**
 * SourceInspector (fusion step 4.5).
 *
 * Scans RAG chunks BEFORE they reach the prompt for adversarial patterns
 * (prompt injection attempts, suspicious URLs, unusual encodings). Three
 * action modes — picked deliberately to balance researcher autonomy
 * against silent risk:
 *   - `warn`: emits a `SecurityEvent`; never drops a chunk.
 *   - `audit`: emits events; drops only chunks with a `high`-severity
 *     suspicious instruction (the "blocking strict" historical default).
 *   - `block`: emits events; drops chunks with a `high` *or* `medium`
 *     severity suspicious instruction. Opt-in for advanced users who
 *     prefer false-positive cost over false-negative cost.
 *
 * Pattern set is intentionally conservative — historical primary sources
 * legitimately contain imperative speech ("ignore everything you knew
 * before…"), so high-severity matches require a directive *plus* a
 * persona-flip phrase, not either alone. Tune by adding patterns; never
 * silently broaden an existing one.
 *
 * Threat model: a malicious source (a Zotero PDF, a foreign Obsidian
 * vault, an MCP-supplied snippet) sneaking instructions into the model.
 * NOT a defence against a compromised local LLM or a user trying to
 * jailbreak their own assistant.
 */

import type { SecurityEvent, SecuritySeverity } from './events.js';
import type { SourceId } from '../types/source.js';

export type InspectorMode = 'warn' | 'audit' | 'block';

export const DEFAULT_INSPECTOR_MODE: InspectorMode = 'warn';

export interface InspectableChunk {
  id: string;
  source: SourceId;
  content: string;
}

export interface InspectionResult {
  /** Chunks the caller should hand to the prompt. With `block` mode this
   * may be shorter than the input; with `warn` mode it equals the input. */
  passed: InspectableChunk[];
  /** Chunks excluded by `block` mode. */
  blocked: InspectableChunk[];
  /** All security events emitted during this scan. */
  events: SecurityEvent[];
}

export interface InspectorConfig {
  mode: InspectorMode;
  /** Optional sink for emitted events (defaults to no-op; main wires it
   * to the JSONL appender at `.cliodeck/v2/security-events.jsonl`). */
  onEvent?: (e: SecurityEvent) => void;
}

// Pattern groups. Each pattern carries its own severity so a generic
// imperative is "low" but an explicit persona-flip is "high".
interface Pattern {
  re: RegExp;
  severity: SecuritySeverity;
  /** Short label for the JSONL `pattern` field — keep stable for analytics. */
  label: string;
}

// Imperatives to disregard prior context.
const SUSPICIOUS_INSTRUCTIONS: Pattern[] = [
  {
    re: /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|all)\b[^.]{0,40}\b(instructions?|prompts?|rules?|context)\b/i,
    severity: 'high',
    label: 'ignore_prior_instructions',
  },
  {
    re: /\byou are now\b[^.]{0,60}\b(a|an)\b[^.]{0,40}\b(assistant|model|ai|expert)\b/i,
    severity: 'high',
    label: 'persona_flip',
  },
  {
    re: /\b(system prompt|instructions?)\b[^.]{0,30}\b(reveal|leak|print|show|display)\b/i,
    severity: 'medium',
    label: 'leak_request',
  },
  {
    re: /\b(jailbreak|DAN mode|developer mode)\b/i,
    severity: 'medium',
    label: 'jailbreak_keyword',
  },
];

// URLs are not malicious by themselves but worth surfacing when they
// appear inside a primary source: an exfiltration vector if a tool were
// later wired to follow links.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

// Long stretches of base64-looking text or zero-width characters often
// indicate hidden payloads.
const UNUSUAL_ENCODING_PATTERNS: Pattern[] = [
  {
    re: /[A-Za-z0-9+/]{120,}={0,2}/,
    severity: 'low',
    label: 'long_base64_blob',
  },
  {
    re: /[\u200B-\u200D\uFEFF]{3,}/,
    severity: 'medium',
    label: 'zero_width_run',
  },
];

function now(): string {
  return new Date().toISOString();
}

export class SourceInspector {
  private readonly mode: InspectorMode;
  private readonly emit: (e: SecurityEvent) => void;

  constructor(cfg: InspectorConfig) {
    this.mode = cfg.mode;
    this.emit = cfg.onEvent ?? (() => undefined);
  }

  inspect(chunks: InspectableChunk[]): InspectionResult {
    const result: InspectionResult = {
      passed: [],
      blocked: [],
      events: [],
    };

    for (const chunk of chunks) {
      const events = this.scan(chunk);
      result.events.push(...events);
      for (const e of events) this.emit(e);

      const triggering = this.findBlockingEvent(events);

      if (triggering) {
        const blockEvent: SecurityEvent = {
          kind: 'prompt_injection_blocked',
          source: chunk.source,
          chunkId: chunk.id,
          mode: this.mode,
          pattern: triggering.pattern,
          severity: triggering.severity,
          at: now(),
        };
        result.events.push(blockEvent);
        this.emit(blockEvent);
        result.blocked.push(chunk);
      } else {
        result.passed.push(chunk);
      }
    }

    return result;
  }

  /**
   * Decide whether to block this chunk. Returns the first
   * suspicious_instruction event that crosses the threshold for the
   * current mode, or `null` if the chunk should pass.
   *
   * - `warn`   never blocks (returns null).
   * - `audit`  blocks on `high` only.
   * - `block`  blocks on `high` *or* `medium`.
   */
  private findBlockingEvent(
    events: SecurityEvent[]
  ): Extract<SecurityEvent, { kind: 'suspicious_instruction' }> | null {
    if (this.mode === 'warn') return null;
    const allowedSeverities: SecuritySeverity[] =
      this.mode === 'audit' ? ['high'] : ['high', 'medium'];
    for (const e of events) {
      if (
        e.kind === 'suspicious_instruction' &&
        allowedSeverities.includes(e.severity)
      ) {
        return e;
      }
    }
    return null;
  }

  private scan(chunk: InspectableChunk): SecurityEvent[] {
    const out: SecurityEvent[] = [];
    const at = now();

    for (const p of SUSPICIOUS_INSTRUCTIONS) {
      if (p.re.test(chunk.content)) {
        out.push({
          kind: 'suspicious_instruction',
          source: chunk.source,
          chunkId: chunk.id,
          pattern: p.label,
          severity: p.severity,
          at,
        });
      }
    }

    const urls = chunk.content.match(URL_RE);
    if (urls) {
      for (const url of new Set(urls)) {
        out.push({
          kind: 'external_url',
          source: chunk.source,
          chunkId: chunk.id,
          url,
          at,
        });
      }
    }

    for (const p of UNUSUAL_ENCODING_PATTERNS) {
      const m = chunk.content.match(p.re);
      if (m) {
        out.push({
          kind: 'unusual_encoding',
          source: chunk.source,
          chunkId: chunk.id,
          detail: `${p.label}: ${m[0].slice(0, 40)}…`,
          severity: p.severity,
          at,
        });
      }
    }

    return out;
  }
}

/**
 * File-backed event sink. Each call appends one JSONL line to
 * `.cliodeck/v2/security-events.jsonl`. Callers buffer + flush as needed;
 * we don't keep an open handle here to stay safe across crashes.
 */
export async function appendSecurityEvent(
  logPath: string,
  event: SecurityEvent
): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, JSON.stringify(event) + '\n', 'utf8');
}
