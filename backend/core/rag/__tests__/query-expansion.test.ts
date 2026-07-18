import { describe, expect, it } from 'vitest';
import {
  expandQueryFrEn,
  expandQueryToText,
} from '../retrievers/secondary-retriever';

/**
 * `expandQueryToText` — variante mono-chaîne du mécanisme d'expansion FR→EN,
 * consommée par tropy-service (un seul embedding + une passe BM25 pour les
 * sources primaires). Contrat : identité stricte quand rien ne matche.
 */
describe('expandQueryToText (expansion FR→EN, sources primaires)', () => {
  it("retourne la requête à l'identique quand aucun terme ne matche", () => {
    const q = 'élections au Volkstag de Danzig en 1932';
    expect(expandQueryToText(q)).toBe(q);
  });

  it('joint la requête originale et les variantes du dictionnaire built-in', () => {
    const out = expandQueryToText('le constructivisme en histoire');
    expect(out.startsWith('le constructivisme en histoire')).toBe(true);
    expect(out).toContain('constructivism');
    expect(out.length).toBeGreaterThan('le constructivisme en histoire'.length);
  });

  it('fusionne le dictionnaire utilisateur par-dessus les défauts', () => {
    const userDict = { volkstag: ['parliament of danzig', 'danzig parliament'] };
    const out = expandQueryToText('débats au Volkstag', userDict);
    expect(out).toContain('parliament of danzig');
    // Et les défauts restent actifs avec le même dictionnaire fusionné.
    expect(expandQueryToText('métacognition', userDict)).toContain('metacognition');
  });

  it('ne duplique pas les variantes identiques', () => {
    const userDict = { volkstag: ['volkstag'] }; // variante égale à un mot de la requête
    const out = expandQueryToText('volkstag', userDict);
    expect(out).toBe('volkstag');
  });

  it('reste cohérent avec le tableau de variantes du chemin secondaire', () => {
    const variants = expandQueryFrEn('métacognition et apprentissage');
    const text = expandQueryToText('métacognition et apprentissage');
    for (const v of variants) {
      expect(text).toContain(v);
    }
  });
});
