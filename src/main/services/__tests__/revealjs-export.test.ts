/**
 * Chaîne slides côté main (chantier « même éditeur ») : frontmatter YAML =
 * source de config reveal (strippé du rendu), découpage partagé
 * (src/editor/slides.ts) pour preview ET export, preview rendue par marked
 * avec ancres de synchro data-aslide.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  // L'export HTML ouvre le fichier écrit dans le navigateur : rien à ouvrir sous Vitest.
  shell: { openPath: async () => '' },
  BrowserWindow: class {},
}));

import {
  extractDeck,
  generatePreviewHtml,
  resolveDeckConfig,
  revealJsExportService,
  type RevealJsExportOptions,
} from '../revealjs-export.js';

const OPTS: RevealJsExportOptions = { projectPath: '/tmp/p', content: '' };

const DECK = `---
title: Danzig 1932
author: Frédéric Clavert
theme: sky
transition: fade
---

# Section une

Contenu de la première slide.

---

## Verticale

Note:
Rappeler la chronologie.

---

\`\`\`markdown
---
# pas une slide : bloc de code
\`\`\`
`;

describe('extractDeck — frontmatter = config reveal', () => {
  it('strippe le frontmatter et lit les métadonnées valides', () => {
    const { body, meta, deck } = extractDeck(DECK);
    expect(meta).toMatchObject({
      title: 'Danzig 1932',
      author: 'Frédéric Clavert',
      theme: 'sky',
      transition: 'fade',
    });
    expect(body.startsWith('\n# Section une')).toBe(true);
    expect(deck.frontmatter).not.toBeNull();
  });

  it("un deck ouvrant sur --- séparateur n'est pas un frontmatter", () => {
    const { meta, deck } = extractDeck('---\n\n# Première slide\n');
    expect(deck.frontmatter).toBeNull();
    expect(meta).toEqual({});
  });

  it('rejette un thème/transition inconnus sans jeter', () => {
    const { meta } = extractDeck('---\ntitle: X\ntheme: vaporwave\ntransition: teleport\n---\n\n# S\n');
    expect(meta.title).toBe('X');
    expect(meta.theme).toBeUndefined();
    expect(meta.transition).toBeUndefined();
  });
});

describe('resolveDeckConfig — précédences', () => {
  it('frontmatter > reveal-config pour theme/transition', () => {
    const r = resolveDeckConfig(DECK, { ...OPTS, config: { theme: 'black', transition: 'zoom' } });
    expect(r.theme).toBe('sky');
    expect(r.transition).toBe('fade');
  });

  it('saisie du modal > frontmatter pour titre/auteur ; frontmatter comble les vides', () => {
    const explicit = resolveDeckConfig(DECK, { ...OPTS, metadata: { title: 'Mon titre', author: 'A. Autre' } });
    expect(explicit.title).toBe('Mon titre');
    expect(explicit.author).toBe('A. Autre');
    const fallback = resolveDeckConfig(DECK, { ...OPTS, metadata: { title: 'Mon titre' } });
    expect(fallback.author).toBe('Frédéric Clavert');
  });
});

describe('generatePreviewHtml — vraie grammaire, rendu de la slide active', () => {
  // La CSP de l'app (`script-src 'self'`) interdit tout script inline, iframe
  // srcDoc comprise : la preview est STATIQUE et ne rend que la slide du
  // curseur ; la synchro se fait par re-génération côté renderer.
  const html = generatePreviewHtml(DECK, OPTS);

  it('ne rend pas le frontmatter comme une slide', () => {
    expect(html).not.toContain('title: Danzig 1932');
  });

  it('rend le markdown côté main (marked), sans mini-moteur data-md', () => {
    expect(html).toContain('<h1>Section une</h1>');
    expect(html).not.toContain('data-md=');
  });

  it("ne contient aucun script inline (CSP de l'app)", () => {
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick=');
  });

  it('affiche la slide demandée et son rang', () => {
    expect(html).toContain('data-aslide="0"');
    expect(html).toContain('1 / 3');
    const second = generatePreviewHtml(DECK, OPTS, 1);
    expect(second).toContain('data-aslide="1"');
    expect(second).toContain('Verticale');
    expect(second).toContain('2 / 3');
  });

  it('sépare les notes présentateur du corps', () => {
    const withNotes = generatePreviewHtml(DECK, OPTS, 1);
    expect(withNotes).toContain('Rappeler la chronologie.');
    // La classe seule figure aussi dans la feuille de style de l'aperçu.
    expect(withNotes).toContain('<div class="slide-notes">');
  });

  it('un --- dans un bloc de code ne crée pas de slide', () => {
    // Le compteur porte le TOTAL du découpage : 3 slides réelles, pas 4.
    expect(html).toContain('1 / 3');
  });

  it('groupe H1 + ## suivants : sous-découpe partageant le même aIndex', () => {
    const grouped = generatePreviewHtml('# S\n\ntexte\n\n## V1\n\nplus\n', OPTS);
    // Deux slides reveal (H1 puis ##) issues du MÊME segment partagé 0.
    expect(grouped).toContain('data-aslide="0"');
    expect(grouped).toContain('1 / 2');
  });
});

// MARK: - Sous-découpage hors blocs de code, jusque dans le navigateur (S12-2-3)

/**
 * Ce que le plugin markdown de reveal.js fait d'une section `data-markdown` à modèle en ligne,
 * relu sur la copie 5.0.4 que l'app met en cache (`reveal-assets-cache`, export hors ligne) : il
 * coupe le texte sur `data-separator` (drapeaux `mg`, défaut `\r?\n---\r?\n`), puis chaque
 * morceau sur `data-separator-notes` (drapeaux `mgi`, défaut `^s*notes?:`, le `\s` perdu dans une
 * chaîne JS), et n'en tire des notes que si ce second découpage rend exactement deux morceaux :
 * sinon tout le texte, `Note:` compris, s'affiche sur la diapositive.
 */
function revealPluginSlides(
  markdown: string,
  separator: string | null,
  notesSeparator: string | null
): Array<{ slide: string; notes: string }> {
  return markdown.split(new RegExp(separator ?? '\r?\n---\r?\n', 'mg')).map((piece) => {
    const split = piece.split(new RegExp(notesSeparator ?? '^s*notes?:', 'mgi'));
    return split.length === 2 ? { slide: split[0], notes: split[1].trim() } : { slide: piece, notes: '' };
  });
}

/** Les sections `data-markdown` du HTML exporté, attributs et modèle compris. */
function exportedSections(html: string): Array<{ attrs: string; markdown: string }> {
  return [...html.matchAll(/<section data-markdown([^>]*)>\s*<textarea data-template>\n([\s\S]*?)\n\s*<\/textarea>/g)].map(
    (m) => ({ attrs: m[1], markdown: m[2] })
  );
}

function attr(attrs: string, name: string): string | null {
  return new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
}

/** Ce que le navigateur projette du HTML exporté, diapositive par diapositive. */
function browserSlides(html: string): Array<{ slide: string; notes: string }> {
  return exportedSections(html).flatMap((s) =>
    revealPluginSlides(s.markdown, attr(s.attrs, 'data-separator'), attr(s.attrs, 'data-separator-notes'))
  );
}

/** Les deux scénarios de la fiche, plus une vraie note après un code qui cite `---` et `Note:`. */
const CODE_DECK = [
  '# Analyse',
  '',
  '```r',
  '## Charger les données',
  'x <- read.csv("a.csv")',
  '```',
  '',
  '---',
  '',
  '## Exemple de syntaxe',
  '',
  '```markdown',
  '---',
  'Note: CODENOTE dans le code',
  '```',
  '',
  'Suite du texte visible.',
  '',
  'Note:',
  'VRAIENOTE à ne pas projeter.',
  '',
].join('\n');

describe('découpage hors blocs de code : aperçu', () => {
  it('un commentaire R `## …` dans un bloc de code ne coupe pas la diapositive', () => {
    const html = generatePreviewHtml('# Analyse\n\n```r\n## Charger les données\nx <- read.csv("a.csv")\n```\n', OPTS);
    expect(html).toContain('1 / 1');
    expect(html).toContain('<code class="language-r">## Charger les données\nx &lt;- read.csv(&quot;a.csv&quot;)\n</code>');
  });

  it('un `Note:` cité dans un bloc de code reste dans le code, et la suite reste projetée', () => {
    const html = generatePreviewHtml(
      '## Exemple de syntaxe\n\n```markdown\nNote: pas une note\nSuite du code\n```\n\nSuite du texte visible.\n',
      OPTS
    );
    expect(html).not.toContain('<div class="slide-notes">');
    expect(html).toContain('Note: pas une note\nSuite du code');
    expect(html).toContain('<p>Suite du texte visible.</p>');
  });
});

describe('découpage hors blocs de code : export HTML, tel que le navigateur le relit', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cliodeck-reveal-notes-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function exportHtml(content: string): Promise<string> {
    const outputPath = join(dir, 'deck.html');
    const result = await revealJsExportService.exportToRevealJs({
      projectPath: join(dir, 'project.json'),
      content,
      outputPath,
    });
    expect(result).toMatchObject({ success: true, outputPath });
    return readFileSync(outputPath, 'utf-8');
  }

  it('chaque section neutralise le second découpage du plugin, et la note porte le repère', async () => {
    const html = await exportHtml(CODE_DECK);
    const sections = exportedSections(html);
    expect(sections).toHaveLength(2);
    for (const s of sections) {
      expect(attr(s.attrs, 'data-separator')).toBe('^CLIODECK-NO-SPLIT$');
      expect(attr(s.attrs, 'data-separator-notes')).toBe('^CLIODECK-SPEAKER-NOTES$');
    }
    expect(sections[1].markdown).toContain('Suite du texte visible.\n\nCLIODECK-SPEAKER-NOTES\nVRAIENOTE');
    // Plus aucune ligne `Note:` hors du code d'origine.
    expect(html.match(/^\s*notes?:.*$/gim)).toEqual(['Note: CODENOTE dans le code']);
  });

  it('le navigateur projette deux diapositives, code entier, note à part', async () => {
    const slides = browserSlides(await exportHtml(CODE_DECK));
    expect(slides).toHaveLength(2);
    expect(slides[0].slide).toContain('## Charger les données\nx <- read.csv("a.csv")\n```');
    expect(slides[1].slide).toContain('```markdown\n---\nNote: CODENOTE dans le code\n```\n\nSuite du texte visible.');
    expect(slides[1].slide).not.toContain('VRAIENOTE');
    expect(slides.map((s) => s.notes)).toEqual(['', 'VRAIENOTE à ne pas projeter.']);
  });

  it('aperçu et export s’accordent sur le même deck : diapositives et notes', async () => {
    const deck = `${DECK}\n---\n\n${CODE_DECK}\n---\n\n# Partie\n\nOuverture\n\nNote: n-ouverture\n\n## Sous-partie\n\nSuite\n\nNotes:\nn-sous\n`;
    const slides = browserSlides(await exportHtml(deck));

    const preview = generatePreviewHtml(deck, OPTS);
    const total = Number(/<span>1 \/ (\d+)<\/span>/.exec(preview)?.[1]);
    expect(slides).toHaveLength(total);

    // L'aperçu montre, pour chaque segment du découpage partagé, sa première diapositive.
    const { deck: shared } = extractDeck(deck);
    const previewNotes = shared.slides.map((s) => {
      const html = generatePreviewHtml(deck, OPTS, s.index);
      return /<div class="slide-notes">([\s\S]*?)<\/div>/.exec(html)?.[1].replace(/<[^>]+>/g, '').trim() ?? '';
    });
    const exportedNotes = slides.map((s) => s.notes).filter(Boolean);
    expect(previewNotes.filter(Boolean)).toEqual([
      'Rappeler la chronologie.',
      'VRAIENOTE à ne pas projeter.',
      'n-ouverture',
    ]);
    expect(exportedNotes).toEqual([
      'Rappeler la chronologie.',
      'VRAIENOTE à ne pas projeter.',
      'n-ouverture',
      'n-sous',
    ]);
    for (const s of slides) expect(s.slide).not.toMatch(/VRAIENOTE|n-ouverture|n-sous|Rappeler/);
  });
});
