/**
 * Toute clé `t('…')` appelée par un composant existe-t-elle dans les trois
 * locales ?
 *
 * C'est le point aveugle documenté du test de parité : il compare les
 * fichiers de traduction ENTRE EUX, il ne peut donc pas voir une clé absente
 * des trois à la fois. C'est ainsi que la modale des réglages OCR est restée
 * entièrement en anglais dans les trois langues, et que la modale d'import de
 * transcriptions faisait de même — 21 clés au total, trouvées seulement en
 * confrontant le code aux locales.
 *
 * Le test vérifie aussi qu'une clé ne pointe pas sur un OBJET : i18next rend
 * alors la clé elle-même. L'infobulle du panneau Similarités affichait
 * littéralement « similarity.help ».
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const LOCALES = path.resolve(__dirname, '../../../../public/locales');
const LANGS = ['fr', 'en', 'de'] as const;

/** Appels `t('clef')`, en ignorant `.t(` d'autres objets. */
const KEY_RE = /(?<![\w.$])t\(\s*['"]([a-zA-Z][\w.]*)['"]/g;

type Json = { [k: string]: Json | string };

function leafKeys(obj: Json, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null
      ? leafKeys(v, `${prefix}${k}.`)
      : [`${prefix}${k}`]
  );
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

const locales = Object.fromEntries(
  LANGS.map((lang) => [
    lang,
    new Set(
      leafKeys(
        JSON.parse(
          fs.readFileSync(path.join(LOCALES, lang, 'common.json'), 'utf8')
        ) as Json
      )
    ),
  ])
) as Record<(typeof LANGS)[number], Set<string>>;

/** i18next : une clé pluralisée vit sous `_one` / `_other`. */
function resolves(key: string, keys: Set<string>): boolean {
  return keys.has(key) || keys.has(`${key}_other`) || keys.has(`${key}_one`);
}

/** Clés effectivement appelées, avec le fichier qui les demande. */
const used = new Map<string, string>();
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  for (const [, key] of src.matchAll(KEY_RE)) {
    // Une clé i18n est toujours qualifiée (`section.clef`) : le filtre
    // écarte les faux positifs du type `config.set('citation', …)`.
    if (!key.includes('.')) continue;
    if (!used.has(key)) used.set(key, path.relative(ROOT, file));
  }
}

describe('clés i18n appelées par le code', () => {
  it('en trouve un nombre plausible (garde-fou du test lui-même)', () => {
    // Si la regex casse, le test deviendrait vert en ne vérifiant rien.
    expect(used.size).toBeGreaterThan(500);
  });

  for (const lang of LANGS) {
    it(`existent toutes dans ${lang}`, () => {
      const missing = [...used.entries()]
        .filter(([key]) => !resolves(key, locales[lang]))
        .map(([key, file]) => `${key}  (${file})`);

      expect(missing).toEqual([]);
    });
  }

  it('ne pointent jamais sur un objet plutôt qu’une chaîne', () => {
    // `t('a.b')` alors que `a.b` est un objet rend la clé elle-même.
    const fr = JSON.parse(
      fs.readFileSync(path.join(LOCALES, 'fr', 'common.json'), 'utf8')
    ) as Json;

    const objectHits = [...used.entries()]
      .filter(([key]) => {
        let node: Json | string = fr;
        for (const part of key.split('.')) {
          if (typeof node !== 'object' || node === null) return false;
          node = node[part];
          if (node === undefined) return false;
        }
        return typeof node === 'object';
      })
      .map(([key, file]) => `${key}  (${file})`);

    expect(objectHits).toEqual([]);
  });
});
