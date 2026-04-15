/**
 * Audit-log redaction helper (companion to `logger.ts` / `events.ts`).
 *
 * The MCP tools and the main-process MCP client manager both write JSONL
 * events to `.cliodeck/v2/mcp-access.jsonl`. Some of those events carry
 * user-supplied text (`query`, `entity`, snippets pulled from notes, etc.)
 * that a historian may consider sensitive — oral-history witness names,
 * anonymised informants, draft hypotheses. Writing those in clear to disk
 * is a quiet leak: the file persists for forever and a colleague opening
 * the laptop can read it.
 *
 * Redaction strategy: replace the value of every known-sensitive key by a
 * `{ sha256, length }` marker. The hash keeps the log useful for
 * correlating repeated queries across sessions without revealing content;
 * the length preserves a small amount of structural information.
 *
 * Non-sensitive metadata (tool name, timestamps, client id, decision,
 * error message, `topK`, …) stays readable so the audit file remains
 * useful at a glance.
 *
 * Secrets in `env` (API keys passed to stdio MCP servers) are masked
 * wholesale — the key survives, the value becomes `[redacted]`.
 */

import { createHash } from 'node:crypto';

const SENSITIVE_KEYS = new Set([
  'query',
  'snippet',
  'content',
  'text',
  'value',
  'context',
  'entity',
]);

export interface RedactedField {
  sha256: string;
  length: number;
}

function hashField(s: string): RedactedField {
  return {
    sha256: createHash('sha256').update(s, 'utf8').digest('hex'),
    length: s.length,
  };
}

/**
 * Recursively walk a payload, replacing sensitive string fields with a
 * `{ sha256, length }` marker. Non-string sensitive fields are coerced to
 * string first. `env` objects have all their values replaced with
 * `[redacted]` — the keys can still be useful for debugging without
 * leaking API secrets.
 */
export function redactForAudit<T>(payload: T): T {
  return redactInternal(payload) as T;
}

function redactInternal(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactInternal);

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'env' && v && typeof v === 'object' && !Array.isArray(v)) {
      const masked: Record<string, string> = {};
      for (const envKey of Object.keys(v as Record<string, unknown>)) {
        masked[envKey] = '[redacted]';
      }
      out[key] = masked;
      continue;
    }
    if (SENSITIVE_KEYS.has(key)) {
      if (typeof v === 'string') {
        out[key] = hashField(v);
      } else if (v === null || v === undefined) {
        out[key] = v;
      } else {
        out[key] = hashField(String(v));
      }
      continue;
    }
    out[key] = redactInternal(v);
  }
  return out;
}
