import { describe, it, expect, vi } from 'vitest';
import { processMarkdownCitations } from '../citation-pipeline';

// Ces tests exercent le VRAI moteur citeproc : chaque appel construit un
// `CSL.Engine` et parse la feuille de style CSL (CitationEngine.ts:95).
// ~700 ms par citation en local, ~4 s sur un coureur d'intégration continue
// — le défaut de 5 s de Vitest y suffit à peine, et le test à deux citations
// le dépassait. On allonge ici plutôt que globalement : un dépassement
// ailleurs doit rester le signe d'un blocage, pas d'une machine lente.
vi.setConfig({ testTimeout: 60_000 });
import type { Citation } from '../../../../backend/types/citation';

function makeCitation(overrides: Partial<Citation>): Citation {
  // Minimal fake — skip getters we don't read in the pipeline.
  return {
    id: 'alice2020',
    type: 'book',
    author: 'Alice, Aline',
    year: '2020',
    title: 'Histoire exemplaire',
    publisher: 'Presses imaginaires',
    ...overrides,
  } as Citation;
}

const resolveMap = (items: Record<string, Citation>) => (key: string) => items[key];

describe('processMarkdownCitations', () => {
  it('is a no-op when no markers are present', async () => {
    const src = 'Un paragraphe sans citation.';
    const res = await processMarkdownCitations(src, { resolve: () => undefined });
    expect(res.md).toBe(src);
    expect(res.footnotes).toHaveLength(0);
    expect(res.bibliography).toHaveLength(0);
    expect(res.missingKeys).toHaveLength(0);
  });

  it('resolves a single [@key] into a numbered footnote + bibliography entry', async () => {
    const cit = makeCitation({ id: 'alice2020' });
    const src = 'Selon Alice [@alice2020], c\'est établi.';
    const res = await processMarkdownCitations(src, {
      resolve: resolveMap({ alice2020: cit }),
      locale: 'fr-FR',
    });
    expect(res.md).toContain('[^1]');
    expect(res.md).not.toContain('[@alice2020]');
    expect(res.footnotes).toHaveLength(1);
    expect(res.footnotes[0].n).toBe(1);
    expect(res.footnotes[0].keys).toEqual(['alice2020']);
    expect(res.footnotes[0].text.length).toBeGreaterThan(0);
    expect(res.bibliography.length).toBeGreaterThan(0);
    expect(res.missingKeys).toHaveLength(0);
  });

  it('leaves the marker intact and reports missing keys', async () => {
    const src = 'Mystère [@ghost1999].';
    const res = await processMarkdownCitations(src, { resolve: () => undefined });
    expect(res.md).toBe(src);
    expect(res.footnotes).toHaveLength(0);
    expect(res.missingKeys).toEqual(['ghost1999']);
  });

  it('supports cluster syntax [@a; @b] as a single footnote', async () => {
    const a = makeCitation({ id: 'alice2020' });
    const b = makeCitation({ id: 'bob2021', author: 'Bob, Bernard', year: '2021', title: 'Autre livre' });
    const src = 'Voir [@alice2020; @bob2021] pour le détail.';
    const res = await processMarkdownCitations(src, {
      resolve: resolveMap({ alice2020: a, bob2021: b }),
      locale: 'fr-FR',
    });
    expect(res.md).toContain('[^1]');
    expect(res.md).not.toContain('[^2]');
    expect(res.footnotes).toHaveLength(1);
    expect(res.footnotes[0].keys).toEqual(['alice2020', 'bob2021']);
    // Bibliography should dedupe and include both.
    expect(res.bibliography.length).toBe(2);
  });
});

/**
 * Régression : les notes générées écrasaient les notes manuelles.
 *
 * La numérotation partait de 1 sans regarder le document. Un `[^1]` écrit
 * par l'auteur et la première citation portaient donc le même numéro : deux
 * appels pour une seule définition, et le texte de l'auteur disparaissait du
 * document exporté (pandoc retient la dernière définition).
 */
describe('numérotation des notes générées', () => {
  const cit = makeCitation({ id: 'alice2020' });

  it('démarre après la dernière note manuelle', async () => {
    const src =
      'Note de l’auteur[^1] puis citation [@alice2020].\n\n[^1]: MA NOTE.\n';
    const res = await processMarkdownCitations(src, {
      resolve: resolveMap({ alice2020: cit }),
    });
    expect(res.footnotes[0].n).toBe(2);
    expect(res.md).toContain('Note de l’auteur[^1]');
    expect(res.md).toContain('citation[^2]');
    // La définition manuelle est intacte et reste seule sur son numéro.
    expect(res.md).toContain('[^1]: MA NOTE.');
    expect((res.md.match(/\[\^1\]/g) ?? []).length).toBe(2); // appel + définition
  });

  it('tient compte du plus grand numéro, pas du nombre de notes', async () => {
    const src = 'Un[^7] et deux[^3].\n\n[^7]: A.\n[^3]: B.\n\nCitation [@alice2020].';
    const res = await processMarkdownCitations(src, {
      resolve: resolveMap({ alice2020: cit }),
    });
    expect(res.footnotes[0].n).toBe(8);
  });

  it('ignore les notes des blocs de code (parse Lezer, pas regex)', async () => {
    const src = 'Texte [@alice2020].\n\n```md\n[^99]: pas une note\n```\n';
    const res = await processMarkdownCitations(src, {
      resolve: resolveMap({ alice2020: cit }),
    });
    expect(res.footnotes[0].n).toBe(1);
  });

  it('numérote plusieurs citations à la suite sans collision', async () => {
    const bob = makeCitation({ id: 'bob2021', author: 'Bob, B' });
    const src = 'Note[^1]. Une [@alice2020] et deux [@bob2021].\n\n[^1]: X.\n';
    const res = await processMarkdownCitations(src, {
      resolve: resolveMap({ alice2020: cit, bob2021: bob }),
    });
    expect(res.footnotes.map((f) => f.n)).toEqual([2, 3]);
  });
});

/**
 * Régression (export Word d'un article réel, 2026-10-02) : les clés
 * restaient telles quelles dans le document. Trois formes n'étaient pas
 * comprises — citation dans une note de l'auteur, clé nue, renvoi de page.
 */
describe('formes de citation au-delà de [@clé] dans le corps', () => {
  const cit = makeCitation({ id: 'alice2020' });
  const resolve = resolveMap({ alice2020: cit });

  it('rend en place une citation écrite dans une note de l’auteur', async () => {
    const src = 'Texte[^a].\n\n[^a]: Voir [@alice2020]. Paru en 2020.\n';
    const res = await processMarkdownCitations(src, { resolve });
    // Pas de note dans la note, pas de clé résiduelle, pas de point doublé.
    expect(res.footnotes).toHaveLength(0);
    expect(res.md).not.toContain('@alice2020');
    expect(res.md).not.toMatch(/\[\^\d+\]/);
    expect(res.md).toContain('*Histoire exemplaire*');
    expect(res.md).not.toContain('..');
    expect(res.bibliography).toHaveLength(1);
  });

  it('comprend une clé nue, dans le corps comme dans une note', async () => {
    const src = 'Selon @alice2020, c’est établi[^1].\n\n[^1]: @alice2020, p. 8.\n';
    const res = await processMarkdownCitations(src, { resolve });
    expect(res.md).toContain('Selon Alice[^2], c’est établi[^1].');
    expect(res.md).toMatch(/\[\^1\]: .*\*Histoire exemplaire\*.*, p\. 8\./);
    expect(res.footnotes.map((f) => f.n)).toEqual([2]);
  });

  it('ne prend ni une adresse ni un identifiant inconnu pour une citation', async () => {
    const src = 'Écrire à alice2020@example.org ou à @inconnu.';
    const res = await processMarkdownCitations(src, { resolve });
    expect(res.md).toBe(src);
    expect(res.missingKeys).toHaveLength(0);
  });

  it('garde préfixe et renvoi de page d’un groupe', async () => {
    const res = await processMarkdownCitations('Fait [voir @alice2020, p. 12].', { resolve });
    expect(res.md).toBe('Fait[^1].');
    expect(res.footnotes[0].text).toMatch(/^voir .*, p\. 12\.$/);
  });

  it('laisse les blocs et extraits de code intacts', async () => {
    const src = 'Syntaxe : `[@alice2020]`.\n\n```\n[@alice2020]\n```\n';
    const res = await processMarkdownCitations(src, { resolve });
    expect(res.md).toBe(src);
  });

  it('rend dans le fil du texte sous un style auteur-date', async () => {
    const res = await processMarkdownCitations('Fait [@alice2020].', {
      resolve,
      style: 'modern-language-association',
      locale: 'en-US',
    });
    expect(res.footnotes).toHaveLength(0);
    expect(res.md).toBe('Fait (Alice).');
    expect(res.bibliography).toHaveLength(1);
  });

  it('ne signale qu’une fois une clé introuvable répétée', async () => {
    const res = await processMarkdownCitations('A [@ghost]. B [@ghost].', { resolve });
    expect(res.missingKeys).toEqual(['ghost']);
  });
});
