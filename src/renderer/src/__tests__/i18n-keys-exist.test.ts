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
 *
 * Chaque clé se résout par une vraie instance d'i18next, sans langue de
 * repli, et non par la liste aplatie des fichiers. Une clé plate à point
 * (`"help.granularity"`) posée à côté d'un objet `help` y figurait bien,
 * mais i18next entre dans l'objet et ne la trouve pas : cinq infobulles des
 * options de similarité affichaient « similarity.help.granularity », etc.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';

const ROOT = path.resolve(__dirname, '..');
const LOCALES = path.resolve(__dirname, '../../../../public/locales');
const LANGS = ['fr', 'en', 'de'] as const;

/** Appels `t('clef')`, en ignorant `.t(` d'autres objets. */
const KEY_RE = /(?<![\w.$])t\(\s*['"]([a-zA-Z][\w.]*)['"]/g;

type Lang = (typeof LANGS)[number];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

const i18n = i18next.createInstance();
await i18n.init({
  resources: Object.fromEntries(
    LANGS.map((lang) => [
      lang,
      {
        common: JSON.parse(
          fs.readFileSync(path.join(LOCALES, lang, 'common.json'), 'utf8')
        ) as Record<string, unknown>,
      },
    ])
  ),
  lng: 'fr',
  // Sans repli : une clé absente en de ne doit pas être trouvée en en.
  fallbackLng: false,
  ns: ['common'],
  defaultNS: 'common',
  showSupportNotice: false,
});

/** i18next : une clé pluralisée vit sous `_one` / `_other`. */
function resolves(key: string, lng: Lang): boolean {
  return [undefined, 1, 2].some((count) => i18n.exists(key, { lng, count }));
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
        .filter(([key]) => !resolves(key, lang))
        .map(([key, file]) => `${key}  (${file})`);

      expect(missing).toEqual([]);
    });
  }

  it.each(LANGS)('ne pointent jamais sur un objet plutôt qu’une chaîne (%s)', (lng) => {
    // `t('a.b')` alors que `a.b` est un objet rend la clé elle-même.
    const objectHits = [...used.entries()]
      .filter(([key]) => typeof i18n.t(key, { lng, returnObjects: true }) === 'object')
      .map(([key, file]) => `${key}  (${file})`);

    expect(objectHits).toEqual([]);
  });
});
