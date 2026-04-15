import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { redactForAudit } from '../audit.js';

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

describe('redactForAudit', () => {
  it('hashes sensitive string fields and preserves length', () => {
    const out = redactForAudit({
      kind: 'tool_call',
      name: 'search_obsidian',
      input: { query: 'témoin anonyme X', topK: 5 },
    }) as {
      input: { query: { sha256: string; length: number }; topK: number };
    };
    expect(out.input.query).toEqual({
      sha256: sha256('témoin anonyme X'),
      length: 'témoin anonyme X'.length,
    });
    expect(out.input.topK).toBe(5);
  });

  it('produces a stable hash for the same value', () => {
    const a = redactForAudit({ query: 'same' }) as { query: { sha256: string } };
    const b = redactForAudit({ query: 'same' }) as { query: { sha256: string } };
    expect(a.query.sha256).toBe(b.query.sha256);
  });

  it('preserves non-sensitive metadata verbatim', () => {
    const event = {
      kind: 'tool_call',
      at: '2026-04-15T12:00:00Z',
      name: 'search_tropy',
      input: { topK: 10 },
      output: { itemCount: 3, totalChars: 120, truncated: false },
      client: { name: 'claude-desktop', version: '0.8' },
    };
    expect(redactForAudit(event)).toEqual(event);
  });

  it('redacts nested sensitive fields (snippet, content, context, text, value, entity)', () => {
    const out = redactForAudit({
      hits: [
        { title: 'keep', snippet: 's1', content: 'c1', context: 'ctx' },
      ],
      probe: { text: 't', value: 'v', entity: 'Marie X' },
    }) as {
      hits: Array<{
        title: string;
        snippet: { sha256: string; length: number };
        content: { sha256: string; length: number };
        context: { sha256: string; length: number };
      }>;
      probe: {
        text: { sha256: string };
        value: { sha256: string };
        entity: { sha256: string };
      };
    };
    expect(out.hits[0].title).toBe('keep');
    expect(out.hits[0].snippet.sha256).toBe(sha256('s1'));
    expect(out.hits[0].content.length).toBe(2);
    expect(out.hits[0].context.sha256).toBe(sha256('ctx'));
    expect(out.probe.text.sha256).toBe(sha256('t'));
    expect(out.probe.value.sha256).toBe(sha256('v'));
    expect(out.probe.entity.sha256).toBe(sha256('Marie X'));
  });

  it('masks env values while keeping keys', () => {
    const out = redactForAudit({
      name: 'my-mcp',
      config: {
        transport: 'stdio',
        command: 'node',
        env: { OPENAI_API_KEY: 'sk-real-secret', DEBUG: '1' },
      },
    }) as {
      name: string;
      config: {
        transport: string;
        command: string;
        env: Record<string, string>;
      };
    };
    expect(out.name).toBe('my-mcp');
    expect(out.config.command).toBe('node');
    expect(out.config.env).toEqual({
      OPENAI_API_KEY: '[redacted]',
      DEBUG: '[redacted]',
    });
  });

  it('leaves primitives and arrays of primitives untouched', () => {
    expect(redactForAudit(null)).toBeNull();
    expect(redactForAudit(42)).toBe(42);
    expect(redactForAudit('hello')).toBe('hello');
    expect(redactForAudit([1, 2, 3])).toEqual([1, 2, 3]);
  });
});
