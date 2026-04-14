import { describe, it, expect } from 'vitest';
import { coerceInputs, parseArgs } from '../cli/args.js';

describe('CLI args parser (4.6)', () => {
  it('handles flags in both forms', () => {
    const p = parseArgs(['--workspace=/tmp/x', '--topK', '5']);
    expect(p.flags.workspace).toBe('/tmp/x');
    expect(p.flags.topK).toBe('5');
  });

  it('treats --flag followed by non-flag as a value (space form)', () => {
    // This is the canonical GNU-style `--flag value` behavior. Callers that
    // want a boolean precede the next positional with another flag or use
    // `--flag=` explicitly.
    const p = parseArgs(['--topK', '5', 'query']);
    expect(p.flags.topK).toBe('5');
    expect(p.positional).toEqual(['query']);
  });

  it('recognises a bare --flag at the end as boolean', () => {
    const p = parseArgs(['search', '--hybrid']);
    expect(p.positional).toEqual(['search']);
    expect(p.booleans.hybrid).toBe(true);
  });

  it('accumulates --input k=v pairs', () => {
    const p = parseArgs([
      '--input',
      'a=1',
      '--input',
      'b=hello',
      '--input=c=true',
    ]);
    expect(p.inputs).toEqual({ a: '1', b: 'hello', c: 'true' });
  });

  it('rejects --input without k=v form', () => {
    expect(() => parseArgs(['--input', 'badvalue'])).toThrow(/k=v/);
  });

  it('coerceInputs honors the recipe input spec', () => {
    const coerced = coerceInputs(
      { a: '42', b: 'true', c: 'hi' },
      {
        a: { type: 'number' },
        b: { type: 'boolean' },
        c: { type: 'string' },
      }
    );
    expect(coerced).toEqual({ a: 42, b: true, c: 'hi' });
  });

  it('rejects non-numeric values coerced to number', () => {
    expect(() =>
      coerceInputs({ a: 'not-a-number' }, { a: { type: 'number' } })
    ).toThrow(/number/);
  });
});
