/**
 * Textes d'aide qui décrivaient une app d'avant : les affirmations relevées ne reviennent pas.
 *
 * - Réglages → Clients MCP annonçait l'usage des outils MCP par le chat « dans une vague
 *   suivante », alors que les outils des serveurs prêts lui sont proposés depuis la fusion
 *   (étape 2.5) : on ajoutait un serveur « pour voir », sans savoir que le modèle pouvait
 *   l'appeler avec des éléments de la conversation (S09-2-7).
 * - Le vault Obsidian était dit indexé dans `.cliodeck/obsidian-vectors.db`. Ce fichier, comme
 *   les autres bases d'avant la fusion, n'existe plus : `migrateWorkspaceToFlat` les a fondus
 *   dans `brain.db`.
 *
 * Liste fermée, comme `locale-accents.test.ts` : le test de parité compare les clés, pas ce que
 * disent les textes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(HERE, '../../../../public/locales');

/** Les bases d'avant la fusion, fondues dans `brain.db` (CLAUDE.md §2). */
const REMOVED_STORES = /(?<![\w-])(vectors|primary-sources|history|obsidian-vectors)\.db\b/;

/** L'usage des outils MCP par le chat, annoncé pour plus tard. */
const MCP_LATER = /vague suivante|later wave|späteren Welle/i;

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

function read(lang: string, ns: string): Array<[string, string]> {
  const file = path.join(LOCALES_DIR, lang, `${ns}.json`);
  return leaves(JSON.parse(readFileSync(file, 'utf-8')) as JsonObject);
}

describe.each(['fr', 'en', 'de'])('affirmations périmées — %s', (lang) => {
  it('aucun texte ne nomme une base d’avant la fusion', () => {
    const found = ['common', 'menu'].flatMap((ns) =>
      read(lang, ns)
        .filter(([, value]) => REMOVED_STORES.test(value))
        .map(([key]) => `${ns}:${key}`)
    );
    expect(found).toEqual([]);
  });

  it('Clients MCP : l’usage des outils par le chat n’est pas annoncé pour plus tard', () => {
    const hint = read(lang, 'common').find(([key]) => key === 'mcp.hint');
    expect(hint).toBeDefined();
    expect(hint?.[1]).not.toMatch(MCP_LATER);
  });
});
