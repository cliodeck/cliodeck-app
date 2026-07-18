/**
 * Locale parity — every locale must expose exactly the same key tree.
 *
 * A missing key silently falls back to another language at runtime (mixed-
 * language UI), and a leaf/object type mismatch makes t() return the raw key.
 * This suite locks both failure modes for common.json and menu.json.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(HERE, '../../../../public/locales');

const LANGUAGES = ['fr', 'en', 'de'] as const;
const NAMESPACES = ['common', 'menu'] as const;

type JsonObject = { [key: string]: unknown };

function loadLocale(lang: string, ns: string): JsonObject {
  const file = path.join(LOCALES_DIR, lang, `${ns}.json`);
  return JSON.parse(readFileSync(file, 'utf-8')) as JsonObject;
}

/** Flatten to dot-paths, recording whether each node is a leaf or an object. */
function keyTypes(obj: JsonObject, prefix = ''): Map<string, 'leaf' | 'object'> {
  const out = new Map<string, 'leaf' | 'object'>();
  for (const [key, value] of Object.entries(obj)) {
    const dotPath = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.set(dotPath, 'object');
      for (const [k, v] of keyTypes(value as JsonObject, dotPath)) out.set(k, v);
    } else {
      out.set(dotPath, 'leaf');
    }
  }
  return out;
}

describe.each(NAMESPACES)('locale parity — %s.json', (ns) => {
  const reference = 'fr';
  const refTypes = keyTypes(loadLocale(reference, ns));

  it.each(LANGUAGES.filter((l) => l !== reference))(
    `${reference} ↔ %s: same key sets`,
    (lang) => {
      const langTypes = keyTypes(loadLocale(lang, ns));
      const missing = [...refTypes.keys()].filter((k) => !langTypes.has(k));
      const orphaned = [...langTypes.keys()].filter((k) => !refTypes.has(k));
      expect(missing, `keys missing in ${lang}/${ns}.json`).toEqual([]);
      expect(orphaned, `keys present only in ${lang}/${ns}.json`).toEqual([]);
    },
  );

  it.each(LANGUAGES.filter((l) => l !== reference))(
    `${reference} ↔ %s: same leaf/object shape`,
    (lang) => {
      const langTypes = keyTypes(loadLocale(lang, ns));
      const mismatched = [...refTypes.entries()]
        .filter(([key, type]) => langTypes.has(key) && langTypes.get(key) !== type)
        .map(([key]) => key);
      expect(mismatched, `type mismatches in ${lang}/${ns}.json`).toEqual([]);
    },
  );
});
