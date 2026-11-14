import { describe, it, expect, vi } from 'vitest';
import { appendEngineCitations, citationKeysIn, processMarkdownCitations } from '../citation-pipeline';

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

describe('citationKeysIn — les clés qu’un export laisse brutes', () => {
  const md = [
    'Voir [@alice2020, p. 3; @bob2019].',
    'Comme le montre @carol2021, et @alice2020 encore.',
    'Écrire à jean@example.org, ou `@code2000` et `[@code2001]`.',
    '```',
    '[@dansuncode] et @dansuncode2',
    '```',
  ].join('\n');

  it('par défaut, seulement les groupes entre crochets, hors code', () => {
    expect(citationKeysIn(md)).toEqual(['alice2020', 'bob2019']);
  });

  it('avec `narrative`, aussi les `@clé` nues, hors code et hors adresse', () => {
    expect(citationKeysIn(md, { narrative: true })).toEqual(['alice2020', 'bob2019', 'carol2021']);
  });
});

/**
 * S12-1-7 : l'export PDF recopiait tels quels les notes et la bibliographie du moteur, que citeproc
 * rend en HTML (`<i>Titre</i>`, `<div class="csl-entry">`). Pandoc lisait des balises brutes, que
 * l'écrivain LaTeX supprime : aucun titre d'ouvrage en italique, ni en note ni en bibliographie,
 * sous un titre « Bibliographie » figé en français, en liste à puces.
 */
describe('appendEngineCitations — notes et bibliographie du moteur, en markdown', () => {
  const farge = makeCitation({
    id: 'Farge_2013',
    author: 'Farge, Arlette',
    year: '2013',
    title: 'The Allure of the Archives',
    publisher: 'Yale University Press',
  });

  it('rend les italiques de citeproc en markdown, sans balise ni puce, sous le titre fourni', async () => {
    const processed = await processMarkdownCitations('Texte [@Farge_2013].\n', {
      resolve: resolveMap({ Farge_2013: farge }),
      style: 'chicago-note-bibliography',
      locale: 'en-US',
    });
    // Ce que citeproc rend vraiment : du HTML.
    expect(processed.footnotes[0].text).toContain('<i>The Allure of the Archives</i>');
    expect(processed.bibliography[0]).toContain('<div class="csl-entry">');

    const md = appendEngineCitations(processed.md, processed, 'References');

    const [body, references] = md.split(/^# References \{\.unnumbered\}$/m);
    expect(references, md).toBeDefined();
    expect(body).toMatch(/^\[\^1\]: Arlette Farge, \*The Allure of the Archives\* \(Yale University Press, 2013\)\.$/m);
    expect(references.trim()).toBe('Farge, Arlette. *The Allure of the Archives*. Yale University Press, 2013.');
    expect(md).not.toMatch(/<\/?(?:i|div)\b/);
    expect(md).not.toMatch(/^- /m);
    expect(md).not.toContain('Bibliographie');
  });

  it('une référence par paragraphe, entités décodées', () => {
    const md = appendEngineCitations(
      'Texte.',
      {
        footnotes: [],
        bibliography: [
          '<div class="csl-entry">Dupont, Jean. <i>Archives &#38; pouvoirs</i>. 2020.</div>',
          '<div class="csl-entry">Martin, Paul. <i>Autre</i>. 2021.</div>',
        ],
      },
      'Literatur'
    );
    expect(md).toBe(
      'Texte.\n\n# Literatur {.unnumbered}\n\n' +
        'Dupont, Jean. *Archives \\& pouvoirs*. 2020.\n\nMartin, Paul. *Autre*. 2021.\n'
    );
  });

  it('sans citation rendue, le markdown reste tel quel : ni titre ni note', () => {
    expect(appendEngineCitations('Texte.', { footnotes: [], bibliography: [] }, 'Références')).toBe('Texte.');
  });

  /**
   * Revue de L10-5 : citeproc écrit un chevron du titre en entité (`&#60;`). Décodé en `<` nu, il
   * rendait au markdown un `<persName>` que pandoc lit comme une balise HTML brute, et que
   * l'écrivain LaTeX supprime : « Encoder les personnes avec <persName> dans la TEI » sortait
   * « Encoder les personnes avec dans la TEI ». Échappé (`\<`), il reste du texte, pour pandoc
   * comme pour `marked` (Word interne). Même chose pour `&` : `&#38;lt;` décodé en `&lt;`, pandoc
   * l'aurait décodé une seconde fois.
   */
  const tei = makeCitation({
    id: 'Durand_2019',
    type: 'article',
    author: 'Durand, Marie',
    year: '2019',
    title: 'Encoder les personnes avec <persName> dans la TEI',
    journal: 'Revue',
  });

  it('un chevron du titre reste du texte, en note comme en bibliographie', async () => {
    const processed = await processMarkdownCitations('Texte [@Durand_2019].\n', {
      resolve: resolveMap({ Durand_2019: tei }),
      style: 'chicago-note-bibliography',
      locale: 'fr-FR',
    });
    // Ce que citeproc rend vraiment : l'entité, pas la balise.
    expect(processed.footnotes[0].text).toContain('&#60;persName&#62;');

    const md = appendEngineCitations(processed.md, processed, 'Références');

    expect(md).toMatch(/^\[\^1\]: Marie Durand, «\u00a0Encoder les personnes avec \\<persName> dans la TEI\u00a0»/m);
    expect(md).toMatch(/^Durand, Marie\. «\u00a0Encoder les personnes avec \\<persName> dans la TEI\u00a0»/m);
    expect(md).not.toMatch(/(?<!\\)<persName>/);
  });

  it('en place (style auteur-date, ou note de l’auteur), le chevron reste du texte aussi', async () => {
    const processed = await processMarkdownCitations('Texte.[^1]\n\n[^1]: Voir [@Durand_2019].\n', {
      resolve: resolveMap({ Durand_2019: tei }),
      style: 'chicago-note-bibliography',
      locale: 'fr-FR',
    });
    expect(processed.md).toContain('\\<persName> dans la TEI');
    expect(processed.md).not.toMatch(/(?<!\\)<persName>/);
  });

  /**
   * citeproc pose en français des espaces insécables autour des guillemets (U+00A0) et devant
   * `:` ou `?` (U+202F). Réduits à une espace ordinaire avec les autres blancs, ils laissaient la
   * ligne se couper entre « et le titre ; recopiés tels quels, pandoc les rend en `~` et `\,`.
   */
  it('les espaces insécables de citeproc restent, en note comme en bibliographie', async () => {
    const processed = await processMarkdownCitations('Texte [@Durand_2019].\n', {
      resolve: resolveMap({ Durand_2019: makeCitation({ ...tei, title: 'Encoder : qui ?' }) }),
      style: 'chicago-note-bibliography',
      locale: 'fr-FR',
    });

    const md = appendEngineCitations(processed.md, processed, 'Références');

    expect(md).toMatch(/^\[\^1\]: Marie Durand, «\u00a0Encoder\u202f: qui\u202f\?\u00a0»/m);
    expect(md).toMatch(/^Durand, Marie\. «\u00a0Encoder\u202f: qui\u202f\?\u00a0»/m);
  });

  it('une entité n’est décodée qu’une fois : `&` et `<` sortent échappés', () => {
    const md = appendEngineCitations(
      'Texte.',
      {
        footnotes: [],
        bibliography: [
          '<div class="csl-entry">Dupont, Jean. <i>Le &#38;lt;br&#38;gt; et &#60;teiHeader&#62;</i>. 2020.</div>',
        ],
      },
      'Références'
    );
    expect(md).toContain('*Le \\&lt;br\\&gt; et \\<teiHeader>*. 2020.');
  });
});
