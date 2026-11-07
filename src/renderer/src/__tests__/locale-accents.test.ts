/**
 * Accents et umlauts — les formes fautives relevées ne reviennent pas.
 *
 * Jusqu'au 2026-11-07, une cinquantaine de chaînes des écrans Zotero,
 * Sécurité, consentement cloud et accueil du projet s'affichaient sans
 * accents (« Parametres Zotero », « cle API », « Bibliotheque »), avec
 * « a » pour « à », et quelques chaînes allemandes avec ae/oe/ue pour
 * ä/ö/ü (« API-Schluessel », « nicht moeglich »). Le test de parité ne
 * pouvait pas les voir : il compare les clés, pas les textes.
 *
 * Liste fermée des formes effectivement corrigées, sans heuristique : un
 * mot de la liste n'est jamais du français ou de l'allemand correct, et la
 * comparaison se fait sur le mot entier. `zitat_schluessel`
 * (`snippets.citationKey`) n'est donc pas visé : c'est un modèle de clé
 * de citation, que pandoc veut en ASCII.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(HERE, '../../../../public/locales');

const NAMESPACES = ['common', 'menu'] as const;

const FAULTY_FORMS: Record<'fr' | 'de', readonly string[]> = {
  fr: [
    'Parametres',
    'specifique',
    'specifiques',
    'numerique',
    'Bibliotheque',
    'bibliotheques',
    'Selectionnez',
    'selectionner',
    'cle',
    'cles',
    'necessite internet',
    'donnees',
    'Repertoire',
    'generalement',
    'Echec',
    'reussie',
    'references bibliographiques',
    'sont configures',
    'Revocation',
    'Revoquer',
    'revoquee',
    'stockees',
    'envoyees',
    'envoye',
    'etes',
    'periode',
    'siecle',
    'reponde',
    'Francais',
    'a utiliser',
    'se connecter a',
  ],
  de: ['Schluessel', 'moeglich', 'waehlen', 'zugaenglich'],
};

type JsonObject = { [key: string]: unknown };

function leaves(obj: JsonObject, prefix = ''): Array<[string, string]> {
  return Object.entries(obj).flatMap(([key, value]): Array<[string, string]> => {
    const dotPath = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') return [[dotPath, value]];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return leaves(value as JsonObject, dotPath);
    }
    return [];
  });
}

/** Le mot ou la locution entière, sans distinction de casse. */
function wholeWord(form: string): RegExp {
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
}

describe.each(['fr', 'de'] as const)('accents — %s', (lang) => {
  it.each(NAMESPACES)('%s.json : aucune forme sans accent relevée', (ns) => {
    const file = path.join(LOCALES_DIR, lang, `${ns}.json`);
    const values = leaves(JSON.parse(readFileSync(file, 'utf-8')) as JsonObject);
    expect(values.length).toBeGreaterThan(0);
    const patterns = FAULTY_FORMS[lang].map((form) => [form, wholeWord(form)] as const);
    const found = values.flatMap(([key, value]) =>
      patterns.filter(([, re]) => re.test(value)).map(([form]) => `${key} : « ${form} »`),
    );
    expect(found, `formes fautives dans ${lang}/${ns}.json`).toEqual([]);
  });
});
