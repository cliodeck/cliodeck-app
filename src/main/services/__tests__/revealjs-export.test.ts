/**
 * Chaîne slides côté main (chantier « même éditeur ») : frontmatter YAML =
 * source de config reveal (strippé du rendu), découpage partagé
 * (src/editor/slides.ts) pour preview ET export, preview rendue par marked
 * avec ancres de synchro data-aslide.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * La fenêtre cachée de l'export PDF, simulée : Chromium n'imprime pas sous Vitest. Elle garde le
 * HTML qu'on lui fait charger, et répond à la sonde de mise en page ce que le test lui dicte
 * (`probe`). Le vrai reveal.js dans le vrai Chromium : `e2e/journey-presentation-pdf.spec.ts`.
 */
const browser = vi.hoisted(() => ({
  userData: '/tmp',
  loadedHtml: '',
  /** Le HTML de chaque page chargée, dans l'ordre. */
  loads: [] as string[],
  /** La fin du chargement de la n-ième page (1, 2…) : `loadFile` attend l'événement `load`. */
  load: (_n: number): Promise<void> => Promise.resolve(),
  probe: (): unknown => 'ready',
  printed: 0,
  windows: 0,
  destroyed: 0,
  /** Les téléchargements passés par `net.fetch` (pile réseau de Chromium, proxy du système). */
  netCalls: 0,
  /**
   * Le protocole des outils de développement de la fenêtre, par lequel l'export observe ce que la
   * page reçoit du réseau : ses écouteurs, et `broken` quand il ne démarre pas.
   */
  listeners: [] as Array<(event: unknown, method: string, params: unknown) => void>,
  debuggerBroken: false,
  detached: 0,
}));

/** Un événement du protocole, tel que Chromium l'envoie pour la page qui se charge. */
function network(method: string, params: Record<string, unknown>): void {
  for (const listener of [...browser.listeners]) listener({}, method, params);
}
const requestSent = (id: string, url: string) => network('Network.requestWillBeSent', { requestId: id, request: { url } });
const dataReceived = (id: string) => network('Network.dataReceived', { requestId: id, dataLength: 64 });
const loadingFinished = (id: string) => network('Network.loadingFinished', { requestId: id });
const KATEX_URL = 'https://cdn.jsdelivr.net/npm/katex@latest/dist/katex.min.js';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => browser.userData) },
  // L'export HTML ouvre le fichier écrit dans le navigateur : rien à ouvrir sous Vitest.
  shell: { openPath: async () => '' },
  // `net.fetch` passe au `fetch` global, que chaque test simule.
  net: {
    fetch: (input: string, init?: RequestInit) => {
      browser.netCalls++;
      return globalThis.fetch(input, init);
    },
  },
  BrowserWindow: class {
    constructor() {
      browser.windows++;
    }
    webContents = {
      executeJavaScript: async () => browser.probe(),
      printToPDF: async () => {
        browser.printed++;
        return Buffer.from('%PDF-1.4\n');
      },
      debugger: {
        attached: false,
        attach() {
          if (browser.debuggerBroken) throw new Error('protocole indisponible');
          browser.listeners = [];
          this.attached = true;
        },
        isAttached() {
          return this.attached;
        },
        detach() {
          this.attached = false;
          browser.detached++;
        },
        on(_event: string, listener: (event: unknown, method: string, params: unknown) => void) {
          browser.listeners.push(listener);
        },
        removeListener(_event: string, listener: (event: unknown, method: string, params: unknown) => void) {
          browser.listeners = browser.listeners.filter((l) => l !== listener);
        },
        sendCommand: async () => ({}),
      },
    };
    /** La page d'amorce, avant la page d'impression : le protocole ne répond qu'après elle. */
    async loadURL() {}
    async loadFile(file: string) {
      browser.loadedHtml = readFileSync(file, 'utf-8');
      browser.loads.push(browser.loadedHtml);
      return browser.load(browser.loads.length);
    }
    isDestroyed() {
      return false;
    }
    destroy() {
      browser.destroyed++;
    }
    close() {}
  },
}));

import {
  extractDeck,
  generatePreviewHtml,
  resolveDeckConfig,
  RevealJsExportService,
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

  /**
   * Revue de L10-3 : un `Note:` dans un commentaire (Cmd+/) ou en tête d'un bloc de code indenté
   * envoyait aux notes tout ce qui le suit dans la diapositive. Aperçu et export, même règle.
   */
  it('un `Note:` dans un commentaire ou un code indenté : la suite reste projetée, aperçu compris', async () => {
    const deck = [
      '## Apres commentaire', '', '<!--', 'Note: NOTEDANSCOMMENTAIRE', '-->', '', 'Texte apres commentaire.', '',
      '---', '',
      '## Code indente', '', 'Avant.', '', '    Note: CODEINDENTE', '    x <- 1', '', 'Apres code VISIBLE.', '',
    ].join('\n');
    const slides = browserSlides(await exportHtml(deck));
    expect(slides.map((s) => s.notes)).toEqual(['', '']);
    expect(slides[0].slide).toContain('<!--\nNote: NOTEDANSCOMMENTAIRE\n-->\n\nTexte apres commentaire.');
    expect(slides[1].slide).toContain('    Note: CODEINDENTE\n    x <- 1\n\nApres code VISIBLE.');

    for (const index of [0, 1]) {
      const preview = generatePreviewHtml(deck, OPTS, index);
      expect(preview).not.toContain('<div class="slide-notes">');
      expect(preview).toMatch(index === 0 ? /<p>Texte apres commentaire\.<\/p>/ : /<p>Apres code VISIBLE\.<\/p>/);
    }
  });

  /**
   * Revue de L10-3 (seconde passe) : en CommonMark, un bloc HTML ouvert par `<img …>` ou `</div>`
   * ne s'arrête qu'à la ligne vide. Un `Note:` tapé juste dessous y tombait, et la note privée
   * s'affichait sur la diapositive projetée, alors que main la cachait.
   */
  it('un `Note:` juste sous une image ou un `</div>` : la note reste privée, aperçu compris', async () => {
    const deck = [
      '## Figure', '', '<img src="figure.png" width="600">', 'Note: NOTEAPRESIMAGE à ne pas projeter.', '',
      '---', '',
      '## Colonnes', '', '<div class="colonnes">', '', 'Texte colonne', '', '</div>', 'Note: NOTEAPRESDIV à ne pas projeter.', '',
    ].join('\n');
    const slides = browserSlides(await exportHtml(deck));
    expect(slides.map((s) => s.notes)).toEqual(['NOTEAPRESIMAGE à ne pas projeter.', 'NOTEAPRESDIV à ne pas projeter.']);
    expect(slides[0].slide).toContain('<img src="figure.png" width="600">');
    expect(slides[1].slide).toMatch(/Texte colonne\n\n<\/div>/);
    for (const s of slides) expect(s.slide).not.toMatch(/NOTEAPRES|Note:/);

    for (const [index, note] of [[0, 'NOTEAPRESIMAGE'], [1, 'NOTEAPRESDIV']] as const) {
      const preview = generatePreviewHtml(deck, OPTS, index);
      const notesAt = preview.indexOf('<div class="slide-notes">');
      expect(notesAt).toBeGreaterThan(-1);
      expect(preview.slice(notesAt)).toContain(`${note} à ne pas projeter.`);
      expect(preview.slice(0, notesAt)).not.toMatch(/NOTEAPRES|Note:/);
    }
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

/**
 * S12-1-18 : l'export PDF chargeait reveal.js depuis le CDN, attendait 2,5 s à l'aveugle, puis
 * imprimait ce qui était affiché. Hors ligne, la page n'était qu'un empilement de `<textarea>` de
 * markdown brut, imprimé, et l'export annoncé réussi ; sur un réseau qui ne répond pas, la fenêtre
 * restait bloquée sur les scripts jusqu'à la limite de l'export.
 */
describe('export PDF : reveal.js depuis le cache, mise en page attendue (S12-1-18)', () => {
  let dir = '';
  const SCRIPT = (url: string) => `/* ${url.split('/').pop()} */`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cliodeck-reveal-pdf-'));
    browser.userData = join(dir, 'userData');
    browser.loadedHtml = '';
    browser.loads = [];
    browser.load = () => Promise.resolve();
    browser.probe = () => 'ready';
    browser.printed = 0;
    browser.windows = 0;
    browser.destroyed = 0;
    browser.netCalls = 0;
    browser.listeners = [];
    browser.debuggerBroken = false;
    browser.detached = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(SCRIPT(url), { headers: { 'content-type': 'application/javascript' } })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const deck = (content = '# Une\n\n---\n\n## Deux\n') => ({
    projectPath: join(dir, 'project.json'),
    content,
    outputPath: join(dir, 'diapos.pdf'),
  });

  it('le HTML chargé ne dépend pas du CDN : reveal.js et ses greffons y sont inclus', async () => {
    const result = await new RevealJsExportService().exportToPDF(deck());

    expect(result, result.error).toMatchObject({ success: true, outputPath: join(dir, 'diapos.pdf') });
    expect(browser.loadedHtml).not.toContain('cdn.jsdelivr.net');
    expect(browser.loadedHtml).toContain('/* reveal.js */');
    expect(browser.loadedHtml).toContain('/* markdown.js */');
    expect(browser.printed).toBe(1);
  });

  it('sans réseau, après un premier export : le cache suffit', async () => {
    const service = new RevealJsExportService();
    expect((await service.exportToPDF(deck())).success).toBe(true);

    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', offline);
    const result = await service.exportToPDF(deck());

    expect(result, result.error).toMatchObject({ success: true });
    expect(offline).not.toHaveBeenCalled();
    expect(browser.loadedHtml).toContain('/* reveal.js */');
  });

  it('sans réseau ni cache : l’échec le dit, et aucun PDF n’est écrit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));

    const result = await new RevealJsExportService().exportToPDF(deck());

    expect(result).toMatchObject({ success: false, errorCode: 'presentation.assetsUnavailable' });
    expect(browser.windows).toBe(0);
    expect(existsSync(join(dir, 'diapos.pdf'))).toBe(false);
  });

  it('une page de portail Wi-Fi au lieu du script : refusée, jamais mise en cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Connectez-vous</html>', { headers: { 'content-type': 'text/html' } })));
    const service = new RevealJsExportService();

    const result = await service.exportToPDF(deck());

    expect(result).toMatchObject({ success: false, errorCode: 'presentation.assetsUnavailable' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(SCRIPT(url), { headers: { 'content-type': 'text/css' } })));
    expect((await service.exportToPDF(deck())).success).toBe(true);
    expect(browser.loadedHtml).not.toContain('Connectez-vous');
  });

  it('un réseau qui ne répond jamais : l’attente est bornée, puis l’échec le dit', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })
    ));

    const result = await new RevealJsExportService({ assetTimeoutMs: 200 }).exportToPDF(deck());

    expect(result).toMatchObject({ success: false, errorCode: 'presentation.assetsUnavailable' });
    expect(browser.windows).toBe(0);
  });

  it('reveal.js jamais prêt : échec dit au bout du délai, rien d’imprimé', async () => {
    browser.probe = () => 'pending';

    const result = await new RevealJsExportService({ renderTimeoutMs: 300 }).exportToPDF(deck());

    expect(result).toMatchObject({ success: false, errorCode: 'presentation.notRendered' });
    expect(browser.printed).toBe(0);
    expect(existsSync(join(dir, 'diapos.pdf'))).toBe(false);
  });

  it(
    'reveal.js absent de la page : échec sans attendre le délai',
    async () => {
      browser.probe = () => 'no-reveal';

      const result = await new RevealJsExportService({ renderTimeoutMs: 600_000 }).exportToPDF(deck());

      expect(result).toMatchObject({ success: false, errorCode: 'presentation.notRendered' });
      expect(browser.printed).toBe(0);
    },
    20_000
  );

  it('des formules que KaTeX, chargé du réseau, n’a pas rendues : le PDF sort, avec la réserve', async () => {
    browser.probe = () => 'math-failed';

    const result = await new RevealJsExportService().exportToPDF(deck('# Loi\n\n$E = mc^2$\n'));

    expect(result).toMatchObject({ success: true, warnings: [{ code: 'presentation.mathNotRendered' }] });
    expect(browser.loadedHtml).toContain('/* math.js */');
    expect(browser.printed).toBe(1);
  });

  it('sans formule, aucune réserve ni greffon de formules', async () => {
    const result = await new RevealJsExportService().exportToPDF(deck());

    expect(result.warnings).toBeUndefined();
    expect(browser.loadedHtml).not.toContain('/* math.js */');
  });
});

/**
 * Revue de L09-12. reveal.js inclus dans la page, il fallait aussi ce que ses fichiers demandent :
 * six thèmes sur onze importent leurs polices par un chemin relatif (`./fonts/…`), qui, recopié
 * dans une page du dossier temporaire, ne menait plus nulle part (PDF en Helvetica), et huit
 * importent Google Fonts, qu'une page d'impression attendait sans borne sur un réseau qui ne répond
 * pas. Le chargement de la page est borné lui aussi : KaTeX vient du réseau.
 */
describe('export PDF et HTML autonome : ce que la page demande au dehors (revue de L09-12)', () => {
  let dir = '';
  const NEVER = () => new Promise<never>(() => undefined);
  const CDN = 'https://cdn.jsdelivr.net/npm/reveal.js@5.0.4';
  const THEME_CSS = [
    '@import url(./fonts/source-sans-pro/source-sans-pro.css);',
    '@import url(https://fonts.googleapis.com/css?family=Lato:400,700);',
    '.reveal { font-family: "Source Sans Pro", Lato, sans-serif; }',
    '',
  ].join('\n');
  const SSP_CSS = [
    '@font-face {',
    "    font-family: 'Source Sans Pro';",
    "    src: url('./source-sans-pro-regular.eot');",
    "    src: url('./source-sans-pro-regular.eot?#iefix') format('embedded-opentype'),",
    "         url('./source-sans-pro-regular.woff') format('woff'),",
    "         url('./source-sans-pro-regular.ttf') format('truetype');",
    '    font-weight: normal;',
    '}',
    '',
  ].join('\n');
  const GOOGLE_CSS = [
    '/* latin */',
    '@font-face {',
    "  font-family: 'Lato';",
    '  src: url(https://fonts.gstatic.com/s/lato/v25/lato-regular.woff2) format(\'woff2\');',
    '  unicode-range: U+0000-00FF;',
    '}',
    '',
  ].join('\n');
  const WOFF = Buffer.from('wOFF-source-sans-pro-regular');
  const WOFF2 = Buffer.from('wOF2-lato-regular');
  const SCRIPT = (url: string) => `/* ${url.split('/').pop()} */`;
  let fetched: string[] = [];

  /** Le CDN et Google Fonts, simulés ; `fontsDown` : les polices ne répondent pas. */
  function network(options: { fontsDown?: boolean } = {}) {
    return vi.fn(async (url: string) => {
      fetched.push(url);
      const css = (body: string) => new Response(body, { headers: { 'content-type': 'text/css' } });
      if (options.fontsDown && /fonts|\.woff/.test(url)) throw new TypeError('fetch failed');
      if (url.endsWith('/dist/theme/black.css')) return css(THEME_CSS);
      if (url.endsWith('/source-sans-pro.css')) return css(SSP_CSS);
      if (url.startsWith('https://fonts.googleapis.com/')) return css(GOOGLE_CSS);
      if (url.endsWith('.woff')) return new Response(WOFF, { headers: { 'content-type': 'font/woff' } });
      if (url.endsWith('.woff2')) return new Response(WOFF2, { headers: { 'content-type': 'font/woff2' } });
      return new Response(SCRIPT(url), { headers: { 'content-type': 'application/javascript' } });
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cliodeck-reveal-review-'));
    browser.userData = join(dir, 'userData');
    browser.loadedHtml = '';
    browser.loads = [];
    browser.load = () => Promise.resolve();
    browser.probe = () => 'ready';
    browser.printed = 0;
    browser.windows = 0;
    browser.destroyed = 0;
    browser.netCalls = 0;
    browser.listeners = [];
    browser.debuggerBroken = false;
    browser.detached = 0;
    fetched = [];
    vi.stubGlobal('fetch', network());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const deck = (content = '# Une\n\n---\n\n## Deux\n', file = 'diapos.pdf') => ({
    projectPath: join(dir, 'project.json'),
    content,
    outputPath: join(dir, file),
  });

  /** Ce que la page chargerait encore du dehors : rien, si tout y est inclus. */
  const outsideReferences = (html: string) =>
    html.match(/@import|\.\/fonts\/|\.eot|\.ttf|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net/g) ?? [];

  it('le thème garde ses polices : relatives et Google Fonts incluses dans la page, en data:', async () => {
    const result = await new RevealJsExportService().exportToPDF(deck());

    expect(result, result.error).toMatchObject({ success: true });
    expect(result.warnings).toBeUndefined();
    const html = browser.loadedHtml;
    expect(html).toContain(`url(data:font/woff;base64,${WOFF.toString('base64')}) format('woff')`);
    expect(html).toContain(`url(data:font/woff2;base64,${WOFF2.toString('base64')}) format('woff2')`);
    expect(html).toContain('unicode-range: U+0000-00FF;');
    expect(outsideReferences(html)).toEqual([]);
    // Les polices précèdent les règles du thème, comme l'`@import` qu'elles remplacent.
    expect(html.indexOf("font-family: 'Lato'")).toBeLessThan(html.indexOf('.reveal { font-family'));
    // Une seule forme téléchargée par police : ni l'.eot ni le .ttf, que Chromium ne lirait pas.
    expect(fetched.filter((url) => /\.(eot|ttf)/.test(url))).toEqual([]);
    expect(fetched).toContain(`${CDN}/dist/theme/fonts/source-sans-pro/source-sans-pro-regular.woff`);
    // Par la pile réseau de Chromium, qui suit le proxy du système, pas par le `fetch` de Node.
    expect(browser.netCalls).toBe(fetched.length);
  });

  it('les polices du thème, une fois téléchargées, servent aussi hors ligne', async () => {
    const service = new RevealJsExportService();
    expect((await service.exportToPDF(deck())).success).toBe(true);
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', offline);

    const result = await service.exportToPDF(deck());

    expect(result, result.error).toMatchObject({ success: true });
    expect(offline).not.toHaveBeenCalled();
    expect(browser.loadedHtml).toContain(`data:font/woff;base64,${WOFF.toString('base64')}`);
  });

  it('polices introuvables : le PDF sort en police de repli, sans rien demander au dehors, et le dit', async () => {
    vi.stubGlobal('fetch', network({ fontsDown: true }));

    const result = await new RevealJsExportService().exportToPDF(deck());

    expect(result, result.error).toMatchObject({ success: true, warnings: [{ code: 'presentation.themeFontsMissing' }] });
    expect(outsideReferences(browser.loadedHtml)).toEqual([]);
    expect(browser.printed).toBe(1);
  });

  it('le HTML autonome inclut les polices du thème de même', async () => {
    const output = join(dir, 'diapos.html');
    const result = await new RevealJsExportService().exportOffline(deck(undefined, 'diapos.html'));

    expect(result).toEqual({ success: true, outputPath: output });
    const html = readFileSync(output, 'utf-8');
    expect(html).toContain(`data:font/woff;base64,${WOFF.toString('base64')}`);
    expect(outsideReferences(html)).toEqual([]);
  });

  it(
    'une page qui ne finit pas de charger (KaTeX) : refaite sans formules, PDF dans le délai, avec la réserve',
    async () => {
      // Sans borne, le chargement ne finirait jamais : le test tomberait sur son propre délai.
      browser.load = (n) => {
        if (n > 1) return Promise.resolve();
        requestSent('katex', KATEX_URL);
        return NEVER();
      };

      const result = await new RevealJsExportService({ renderTimeoutMs: 300 }).exportToPDF(deck('# Loi\n\n$E = mc^2$\n'));

      expect(result, result.error).toMatchObject({ success: true, warnings: [{ code: 'presentation.mathNotRendered' }] });
      expect(browser.loads).toHaveLength(2);
      expect(browser.loads[0]).toContain('/* math.js */');
      expect(browser.loads[1]).not.toContain('/* math.js */');
      expect(browser.loads[1]).not.toContain('RevealMath');
      expect(browser.destroyed).toBeGreaterThanOrEqual(1);
      expect(browser.printed).toBe(1);
    },
    20_000
  );

  it(
    'une image distante qui ne répond plus : échec dans le délai, qui nomme l’image, rien d’imprimé',
    async () => {
      browser.load = () => {
        requestSent('img', 'https://example.org/carte.png');
        return NEVER();
      };

      const result = await new RevealJsExportService({ renderTimeoutMs: 300 }).exportToPDF(
        deck('# Carte\n\n![](https://example.org/carte.png)\n')
      );

      expect(result).toMatchObject({
        success: false,
        errorCode: 'presentation.resourceNotResponding',
        errorParams: { resources: 'https://example.org/carte.png', count: 1 },
      });
      expect(browser.loads).toHaveLength(1);
      expect(browser.printed).toBe(0);
      expect(existsSync(join(dir, 'diapos.pdf'))).toBe(false);
    },
    20_000
  );

  /**
   * Revue de L09-12, seconde passe : le chargement était borné au total (30 s), et une image
   * d'archive qui arrivait lentement, mais arrivait, faisait échouer l'export, alors qu'il
   * réussissait avant. C'est l'inactivité qui est bornée : rien reçu pendant `renderTimeoutMs`.
   */
  it(
    'une image distante lente qui arrive : attendue tant qu’elle progresse, au-delà du délai, et le PDF sort',
    async () => {
      browser.load = () =>
        new Promise<void>((resolve) => {
          requestSent('img', 'https://example.org/archive.png');
          let chunks = 0;
          const timer = setInterval(() => {
            dataReceived('img');
            if (++chunks < 25) return;
            clearInterval(timer);
            loadingFinished('img');
            resolve();
          }, 100);
        });
      const started = Date.now();

      const result = await new RevealJsExportService({ renderTimeoutMs: 1000 }).exportToPDF(
        deck('# Archive\n\n![](https://example.org/archive.png)\n')
      );

      expect(result, result.error).toMatchObject({ success: true });
      // Au-delà du délai d'inactivité : seule la progression a pu faire attendre la page.
      expect(Date.now() - started).toBeGreaterThan(1000);
      expect(browser.loads).toHaveLength(1);
      expect(browser.printed).toBe(1);
      // L'observation s'arrête avec le chargement : rien n'en reste pendant l'impression.
      expect(browser.detached).toBe(1);
      expect(browser.listeners).toEqual([]);
    },
    20_000
  );

  it(
    'une image qui progresse sans fin : l’attente a un plafond, et l’échec nomme l’image',
    async () => {
      let timer: ReturnType<typeof setInterval> | undefined;
      browser.load = () => {
        requestSent('img', 'https://example.org/archive.tif');
        timer = setInterval(() => dataReceived('img'), 100);
        return NEVER();
      };

      try {
        const result = await new RevealJsExportService({ renderTimeoutMs: 1000, loadLimitMs: 1500 }).exportToPDF(
          deck('# Archive\n\n![](https://example.org/archive.tif)\n')
        );

        expect(result).toMatchObject({
          success: false,
          errorCode: 'presentation.pageLoadTooLong',
          errorParams: { resources: 'https://example.org/archive.tif', count: 1 },
        });
        expect(browser.printed).toBe(0);
      } finally {
        clearInterval(timer);
      }
    },
    20_000
  );

  it(
    'une image redirigée qui ne répond plus : l’échec nomme l’adresse écrite dans les diapositives',
    async () => {
      browser.load = () => {
        requestSent('img', 'https://example.org/carte.png');
        requestSent('img', 'https://cache.example.net/a1b2c3.png');
        return NEVER();
      };

      const result = await new RevealJsExportService({ renderTimeoutMs: 300 }).exportToPDF(
        deck('# Carte\n\n![](https://example.org/carte.png)\n')
      );

      expect(result).toMatchObject({
        errorCode: 'presentation.resourceNotResponding',
        errorParams: { resources: 'https://example.org/carte.png', count: 1 },
      });
    },
    20_000
  );

  it(
    'formules et image distante qui ne répondent plus : KaTeX n’est pas mis en cause, l’image est nommée',
    async () => {
      browser.load = () => {
        requestSent('katex', KATEX_URL);
        requestSent('img', 'https://example.org/carte.png');
        return NEVER();
      };

      const result = await new RevealJsExportService({ renderTimeoutMs: 300 }).exportToPDF(
        deck('# Loi\n\n$E = mc^2$\n\n![](https://example.org/carte.png)\n')
      );

      expect(result).toMatchObject({
        success: false,
        errorCode: 'presentation.resourceNotResponding',
        errorParams: { resources: 'https://example.org/carte.png', count: 1 },
      });
      // Pas de seconde page sans formules : elle attendrait la même image.
      expect(browser.loads).toHaveLength(1);
    },
    20_000
  );

  it(
    'réseau de la page inobservable : l’attente reste bornée au total, et l’échec le dit',
    async () => {
      browser.debuggerBroken = true;
      browser.load = NEVER;

      const result = await new RevealJsExportService({ renderTimeoutMs: 300 }).exportToPDF(
        deck('# Carte\n\n![](https://example.org/carte.png)\n')
      );

      expect(result).toMatchObject({ success: false, errorCode: 'presentation.pageNotLoaded' });
      expect(browser.printed).toBe(0);
    },
    20_000
  );

  it(
    'réseau de la page inobservable, deck à formules : refaite sans formules, comme avant',
    async () => {
      browser.debuggerBroken = true;
      browser.load = (n) => (n === 1 ? NEVER() : Promise.resolve());

      const result = await new RevealJsExportService({ renderTimeoutMs: 300 }).exportToPDF(deck('# Loi\n\n$E = mc^2$\n'));

      expect(result, result.error).toMatchObject({ success: true, warnings: [{ code: 'presentation.mathNotRendered' }] });
      expect(browser.loads).toHaveLength(2);
    },
    20_000
  );

  /**
   * Revue de L09-12, seconde passe : le greffon des formules était un fichier obligatoire. Le HTML
   * autonome ne le met jamais en cache : hors ligne, tout l'export PDF d'un deck à formules
   * échouait (`assetsUnavailable`), alors que le PDF sait sortir sans KaTeX.
   */
  it('formules hors ligne, greffon jamais mis en cache : le PDF sort sans formules, avec la réserve', async () => {
    const service = new RevealJsExportService();
    expect((await service.exportOffline(deck(undefined, 'diapos.html'))).success).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));

    const result = await service.exportToPDF(deck('# Une loi\n\n$E = mc^2$\n'));

    expect(result, result.error).toMatchObject({ success: true, warnings: [{ code: 'presentation.mathNotRendered' }] });
    expect(browser.loadedHtml).not.toContain('RevealMath');
    expect(outsideReferences(browser.loadedHtml)).toEqual([]);
    expect(browser.printed).toBe(1);
  });

  /**
   * Revue de L09-12, seconde passe : deux montants en dollars sur une ligne passaient pour une
   * formule. Règle de pandoc : un `$` ouvrant suivi d'un caractère non blanc, un `$` fermant
   * précédé d'un caractère non blanc et non suivi d'un chiffre.
   */
  it('des montants en dollars ne sont pas des formules : ni réserve, ni greffon', async () => {
    const budget = '# Budget\n\nLe budget passe de $200 à $300 millions, puis de $ 50 à $ 80.\n';
    const offline = await new RevealJsExportService().exportOffline(deck(budget, 'budget.html'));
    const pdf = await new RevealJsExportService().exportToPDF(deck(budget));

    expect(offline).toEqual({ success: true, outputPath: join(dir, 'budget.html') });
    expect(pdf, pdf.error).toEqual({ success: true, outputPath: join(dir, 'diapos.pdf') });
    expect(browser.loadedHtml).not.toContain('RevealMath');
    expect(fetched.filter((url) => url.endsWith('/math.js'))).toEqual([]);
  });

  it.each([
    ['$x$'],
    ['Soit $n$ documents, pour $5 de plus.'],
    ['$$\n\\int_0^1 f\n$$'],
    ['\\(a + b\\)'],
  ])('« %s » est une formule : le HTML autonome le dit', async (formula) => {
    const result = await new RevealJsExportService().exportOffline(deck(`# F\n\n${formula}\n`, 'f.html'));

    expect(result.warnings).toEqual([{ code: 'presentation.mathNotIncludedOffline' }]);
  });

  it('HTML autonome d’un deck à formules : écrit, avec la réserve qui dit les formules brutes', async () => {
    const output = join(dir, 'diapos.html');
    const result = await new RevealJsExportService().exportOffline(deck('# Loi\n\n$E = mc^2$\n', 'diapos.html'));

    expect(result).toEqual({
      success: true,
      outputPath: output,
      warnings: [{ code: 'presentation.mathNotIncludedOffline' }],
    });
    expect(readFileSync(output, 'utf-8')).not.toContain('RevealMath');
  });

  it('une page de portail laissée dans le cache par une version antérieure n’est pas reprise', async () => {
    const cacheDir = join(browser.userData, 'reveal-assets-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'npm__reveal.js@5.0.4__dist__reveal.js'), '<!DOCTYPE html><html>Connectez-vous</html>');

    const result = await new RevealJsExportService().exportToPDF(deck());

    expect(result, result.error).toMatchObject({ success: true });
    expect(fetched).toContain(`${CDN}/dist/reveal.js`);
    expect(browser.loadedHtml).not.toContain('Connectez-vous');
    expect(readFileSync(join(cacheDir, 'npm__reveal.js@5.0.4__dist__reveal.js'), 'utf-8')).toBe('/* reveal.js */');
  });

  it('reveal.js du cache qui ne tourne pas : cache oublié, fichiers repris du réseau une fois', async () => {
    const service = new RevealJsExportService();
    expect((await service.exportToPDF(deck())).success).toBe(true);
    fetched = [];
    let probes = 0;
    browser.probe = () => (probes++ === 0 ? 'no-reveal' : 'ready');

    const result = await service.exportToPDF(deck());

    expect(result, result.error).toMatchObject({ success: true });
    expect(fetched).toContain(`${CDN}/dist/reveal.js`);
    expect(browser.printed).toBe(2);
  });

  it('reveal.js qui ne tourne pas, même repris du réseau : échec dit, une seule reprise', async () => {
    const service = new RevealJsExportService();
    expect((await service.exportToPDF(deck())).success).toBe(true);
    browser.probe = () => 'no-reveal';
    browser.windows = 0;
    fetched = [];

    const result = await service.exportToPDF(deck());

    expect(result).toMatchObject({ success: false, errorCode: 'presentation.notRendered' });
    expect(fetched.filter((url) => url === `${CDN}/dist/reveal.js`)).toHaveLength(1);
    expect(browser.windows).toBe(2);
  });
});
