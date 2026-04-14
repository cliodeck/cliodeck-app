/**
 * Tiny flag parser for the cliodeck CLI (fusion step 4.6).
 *
 * Avoids pulling a dependency for what's a 30-line need. Supports:
 *   --flag=value        long form
 *   --flag value        space-separated
 *   --bool              boolean flag (present = true)
 *   --input k=v         repeatable: `inputs` becomes a dict
 *   positional arguments
 *
 * No coercion beyond `--input`; values are strings. Callers coerce
 * per-command (JSON parse, int, etc.).
 */

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
  booleans: Record<string, true>;
  inputs: Record<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    positional: [],
    flags: {},
    booleans: {},
    inputs: {},
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out.positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    let key: string;
    let value: string | undefined;
    if (eq > 0) {
      key = token.slice(2, eq);
      value = token.slice(eq + 1);
    } else {
      key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        value = next;
        i += 1;
      }
    }
    if (value === undefined) {
      out.booleans[key] = true;
      continue;
    }
    if (key === 'input') {
      const eqIdx = value.indexOf('=');
      if (eqIdx < 0) {
        throw new Error(`--input expects k=v form, got: ${value}`);
      }
      out.inputs[value.slice(0, eqIdx)] = value.slice(eqIdx + 1);
      continue;
    }
    out.flags[key] = value;
  }

  return out;
}

export function coerceInputs(
  raw: Record<string, string>,
  typed: Record<string, { type: 'string' | 'number' | 'boolean' | 'path' }>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const spec = typed[k];
    if (!spec) {
      out[k] = v;
      continue;
    }
    switch (spec.type) {
      case 'number': {
        const n = Number(v);
        if (Number.isNaN(n)) throw new Error(`--input ${k} must be a number`);
        out[k] = n;
        break;
      }
      case 'boolean':
        out[k] = v === 'true' || v === '1';
        break;
      case 'string':
      case 'path':
      default:
        out[k] = v;
    }
  }
  return out;
}
