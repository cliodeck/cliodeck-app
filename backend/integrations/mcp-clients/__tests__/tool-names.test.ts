import { describe, it, expect } from 'vitest';
import { buildWireToolName } from '../tool-names.js';

/**
 * Ce que tous les fournisseurs acceptent : OpenAI, Anthropic et Mistral `[a-zA-Z0-9_-]{1,64}`,
 * Gemini une lettre ou `_` en tête (S09-1-23).
 */
const WIRE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
const none: ReadonlySet<string> = new Set();

describe('buildWireToolName — le nom d’outil MCP envoyé au modèle', () => {
  it('un serveur nommé avec une espace donne un nom accepté par les fournisseurs, lisible', () => {
    const wire = buildWireToolName('Gallica BnF', 'search', none);
    expect(wire).toMatch(WIRE);
    expect(wire.startsWith('Gallica_BnF__search')).toBe(true);
  });

  it('les accents perdent leur diacritique, un point devient `_`', () => {
    const wire = buildWireToolName('Archives départementales', 'a.b', none);
    expect(wire).toMatch(WIRE);
    expect(wire.startsWith('Archives_departementales__a_b')).toBe(true);
  });

  it('un nom déjà valide ne change pas', () => {
    expect(buildWireToolName('zotero', 'search_items', none)).toBe('zotero__search_items');
    expect(buildWireToolName('my-server', 'get-thing', none)).toBe('my-server__get-thing');
    expect(buildWireToolName('_srv', 'x', none)).toBe('_srv__x');
  });

  it('deux noms bruts qui s’assainissent pareil donnent deux noms envoyés distincts', () => {
    const spaced = buildWireToolName('a b', 'x', none);
    const dotted = buildWireToolName('a.b', 'x', none);
    const underscored = buildWireToolName('a_b', 'x', none);
    expect(underscored).toBe('a_b__x');
    for (const wire of [spaced, dotted]) expect(wire).toMatch(WIRE);
    expect(new Set([spaced, dotted, underscored]).size).toBe(3);
    // Dans l'autre ordre, avec le premier déjà pris : rien ne change.
    expect(buildWireToolName('a b', 'x', new Set([underscored, dotted]))).toBe(spaced);
  });

  it('deux noms longs qui ne diffèrent qu’au-delà du 64ᵉ caractère restent distincts, bornés à 64', () => {
    const stem = 'Archives'.repeat(10);
    const first = buildWireToolName(stem, 'search_a', none);
    const second = buildWireToolName(stem, 'search_b', none);
    expect(first).toMatch(WIRE);
    expect(second).toMatch(WIRE);
    expect(first).not.toBe(second);
    const longTool = buildWireToolName('srv', `${'t'.repeat(200)}`, none);
    expect(longTool).toMatch(WIRE);
    expect(longTool.startsWith('srv__ttt')).toBe(true);
  });

  it('un nom long garde une part de l’outil, pas seulement le serveur', () => {
    const wire = buildWireToolName('Archives nationales '.repeat(5), 'search_items', none);
    expect(wire).toMatch(WIRE);
    expect(wire).toContain('__search_items');
  });

  it('le nom envoyé ne dépend que du nom brut, pas des autres outils', () => {
    const alone = buildWireToolName('Gallica BnF', 'search', none);
    const crowded = buildWireToolName('Gallica BnF', 'search', new Set(['Gallica_BnF__fetch', 'srv__x']));
    expect(crowded).toBe(alone);
  });

  it('un nom qui commence par un chiffre ou un tiret reçoit un préfixe', () => {
    for (const client of ['1914-1918', '-srv']) {
      const wire = buildWireToolName(client, 'search', none);
      expect(wire).toMatch(WIRE);
      expect(wire).toContain(client.replace(/^-/, ''));
    }
  });

  it('un nom vide après assainissement reçoit un nom de repli', () => {
    const client = buildWireToolName('日本', 'search', none);
    const both = buildWireToolName('日本', '検索', none);
    const other = buildWireToolName('中国', '検索', none);
    for (const wire of [client, both, other]) expect(wire).toMatch(WIRE);
    expect(client).toContain('__search');
    expect(new Set([client, both, other]).size).toBe(3);
  });

  it('dernier recours : un nom déjà pris est remplacé par un nom libre, valide', () => {
    const first = buildWireToolName('Gallica BnF', 'search', none);
    const second = buildWireToolName('Gallica BnF', 'search', new Set([first]));
    const third = buildWireToolName('Gallica BnF', 'search', new Set([first, second]));
    for (const wire of [second, third]) expect(wire).toMatch(WIRE);
    expect(new Set([first, second, third]).size).toBe(3);
    // Un nom valide déjà pris (un outil listé deux fois) n'est pas rendu deux fois.
    const again = buildWireToolName('srv', 'x', new Set(['srv__x']));
    expect(again).toMatch(WIRE);
    expect(again).not.toBe('srv__x');
    // Même à 64 caractères, le compteur tient dans la borne.
    const long = buildWireToolName('Archives'.repeat(10), 'search', none);
    const longAgain = buildWireToolName('Archives'.repeat(10), 'search', new Set([long]));
    expect(longAgain).toMatch(WIRE);
    expect(longAgain).not.toBe(long);
  });
});
