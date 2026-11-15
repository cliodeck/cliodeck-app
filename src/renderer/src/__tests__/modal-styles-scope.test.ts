/**
 * Une feuille de style ne touche que son composant : l'allure d'une fenêtre ou d'un panneau ne
 * dépend pas de ce qui a été ouvert avant lui.
 *
 * Les classes communes des fenêtres modales n'ont qu'une feuille : `components/common/Modal.css`,
 * chargée au démarrage. Jusqu'au 2026-11 (H1), `.modal-overlay`, `.modal-content`,
 * `.modal-header`… n'étaient écrites que dans la feuille de la fenêtre OCR, chargée avec le
 * panneau Sources primaires, à la demande : avant lui, le choix d'import d'un `.bib` s'affichait
 * rogné en bas de la colonne de gauche. Et d'autres feuilles propres à une fenêtre (Méthodologie,
 * renommage de PDF, import BibTeX…) posaient sans portée des règles sur ces mêmes classes :
 * l'allure d'une fenêtre dépendait des panneaux ouverts avant elle. Une règle propre à une fenêtre
 * se pose sous la classe de sa fenêtre (`.methodology-modal .modal-content`) ; ce garde-fou
 * empêche le retour des règles sans portée.
 *
 * J13 (2026-11) étend la règle à tous les composants. Trois fuites l'ont montré, chacune venue
 * d'une feuille chargée à la demande :
 * - les fenêtres d'export PDF et Word (`PDFExportModal.css`) et de présentation
 *   (`PresentationExportModal.css`) déclaraient sans portée les mêmes classes, à des valeurs
 *   différentes : la feuille chargée la dernière l'emportait (message de progression centré,
 *   16 px sous la progression…). Leurs règles communes sont dans `Export/ExportModal.css`, sous
 *   `.export-modal` ;
 * - « Signaler un problème » n'avait son bouton bleu qu'après un export : `.btn-export` venait
 *   des feuilles d'export ;
 * - `.progress-bar` des statistiques des Sources primaires, une fois ce panneau ouvert, peignait
 *   la barre des exports en gris clair, sur 6 px.
 *
 * Deux contrôles, sur tous les composants :
 * - une classe d'ancrage (les classes du premier sélecteur composé d'une règle, avant tout
 *   combinateur, `:where(…)` compris, après un éventuel contexte de thème comme `.dark`) ne
 *   s'ancre que dans une feuille, hors des feuilles globales (`index.css`,
 *   `components/common/Modal.css`) : deux feuilles qui ancrent des règles sur la même classe se
 *   disputent les mêmes éléments, et l'ordre de chargement décide ;
 * - une règle d'une feuille chargée à la demande n'atteint pas un composant qu'elle n'accompagne
 *   pas à coup sûr, c'est-à-dire un composant qui porte toutes les classes qu'exige le sélecteur
 *   alors que la feuille n'est pas chargée chaque fois qu'il l'est.
 *
 * Les classes d'un composant sont lues dans les littéraux de ses attributs `className` : la
 * chaîne, ou, entre accolades, toute chaîne et tout gabarit (conditions et `clsx(…)` compris ;
 * un nom de variable glissé dans un gabarit compte aussi, ce qui ne peut qu'ajouter une alerte).
 * Ce que le test ne voit pas : une classe construite hors de l'attribut (`const cls = …` puis
 * `className={cls}`), passée par une autre propriété (`iconClassName`) ou posée par le DOM
 * (`classList`, widgets CodeMirror de `src/editor`) ; un sélecteur dont les classes se
 * répartissent entre un parent et un enfant écrits dans deux fichiers (il les exige toutes dans
 * le même) ; une règle sans classe (`button { … }`) ; une règle globale d'`index.css`. Ni un
 * composant qui emprunte une classe à une feuille chargée au démarrage, quand elle est seule à
 * l'ancrer : son allure ne dépend pas de l'ordre d'ouverture, mais il dépend d'une feuille qui
 * n'est pas la sienne (« Signaler un problème » prenait ainsi sa croix et « Annuler » aux
 * feuilles de la bibliographie).
 *
 * Le stock trouvé le 2026-11-15, hors des trois fuites, est inventorié plus bas : stock connu,
 * à réduire, aucune entrée nouvelle.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const SCANNED_DIRS = [path.join(ROOT, 'src/renderer/src'), path.join(ROOT, 'src/editor')];
const COMMON_SHEET = path.join(ROOT, 'src/renderer/src/components/common/Modal.css');
const ENTRY = path.join(ROOT, 'src/renderer/src/main.tsx');

/** Une classe commune des fenêtres : `.modal-…` (pas `.help-modal-…`) ou `.close-button`. */
const COMMON_CLASS = /\.(?:modal-[a-z-]+|close-button)(?![\w-])/;
const CLASS_TOKEN = /\.[A-Za-z_-][\w-]*/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(p, out);
    } else if (entry.name.endsWith('.css')) {
      out.push(p);
    }
  }
  return out;
}

/** Coupe un texte sur `sep`, hors des parenthèses (`:where(.a, .b)` reste entier). */
function splitTopLevel(text: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && sep.test(ch)) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Les sélecteurs des règles d'une feuille, un par élément de liste ; les règles `@` sont sautées. */
function selectors(css: string): string[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: string[] = [];
  for (const match of code.matchAll(/([^{};]+)\{/g)) {
    const prelude = match[1].trim();
    if (prelude.startsWith('@')) continue;
    found.push(...splitTopLevel(prelude, /,/));
  }
  return found;
}

/**
 * Sans portée : rien, avant la classe commune ni dans le même sélecteur composé, ne nomme
 * une fenêtre (une autre classe, ou un id).
 */
function isUnscoped(selector: string): boolean {
  const match = COMMON_CLASS.exec(selector);
  if (!match) return false;
  const rest = selector.slice(match.index);
  const end = rest.search(/[\s>+~]/);
  const head = selector.slice(0, match.index) + (end === -1 ? rest : rest.slice(0, end));
  const scopes = (head.match(CLASS_TOKEN) ?? []).filter((c) => !COMMON_CLASS.test(c));
  return scopes.length === 0 && !/#[A-Za-z]/.test(head);
}

describe('fenêtres modales : une seule feuille pour les classes communes', () => {
  it('aucune règle sans portée sur une classe commune hors de components/common/Modal.css', () => {
    const files = SCANNED_DIRS.flatMap((d) => walk(d)).filter((f) => f !== COMMON_SHEET);
    expect(files.length).toBeGreaterThan(50);
    const found = files.flatMap((file) =>
      selectors(fs.readFileSync(file, 'utf8'))
        .filter(isUnscoped)
        .map((s) => `${path.relative(ROOT, file)}: ${s}`),
    );
    expect(found).toEqual([]);
  });

  it('la feuille commune porte les règles de base et se charge avec l’app, pas avec un panneau', () => {
    expect(fs.existsSync(COMMON_SHEET)).toBe(true);
    const base = selectors(fs.readFileSync(COMMON_SHEET, 'utf8'));
    for (const cls of ['.modal-overlay', '.modal-content', '.modal-header', '.modal-body', '.modal-footer', '.close-button']) {
      expect(base).toContain(cls);
    }
    // Importée par le point d'entrée du renderer, après index.css (et donc après les feuilles
    // des composants chargés au démarrage, comme l'était celle de l'OCR une fois chargée).
    const entry = fs.readFileSync(ENTRY, 'utf8');
    const sheet = entry.indexOf("import './components/common/Modal.css';");
    expect(sheet).toBeGreaterThan(entry.indexOf("import './index.css';"));
  });

  it('le repérage distingue une règle posée sous sa fenêtre d’une règle sans portée', () => {
    expect(isUnscoped('.modal-content')).toBe(true);
    expect(isUnscoped('.modal-nav button.active')).toBe(true);
    expect(isUnscoped('.modal-content::-webkit-scrollbar')).toBe(true);
    expect(isUnscoped('.close-button:hover')).toBe(true);
    expect(isUnscoped('.methodology-modal .modal-content')).toBe(false);
    expect(isUnscoped('.modal-content.bib-import-mode-modal')).toBe(false);
    expect(isUnscoped('.help-modal-overlay')).toBe(false);
    expect(isUnscoped('.stats-header .close-button')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Les feuilles des panneaux chargés à la demande.
//
// Une feuille importée par un module chargé à la demande (`lazy(() => import(…))`) n'entre
// dans la page qu'avec lui, et, venue plus tard, l'emporte à spécificité égale. Une règle sans
// portée y touche donc les fenêtres déjà chargées, mais seulement une fois ce panneau ouvert :
// après les Sources primaires, le bouton « Remplacer » du choix d'import passait du bleu à
// l'orange de l'OCR (`.btn-primary`), et les étiquettes du récapitulatif en capitales
// (`.stat-item .stat-label`) — revue de H1. Le graphe d'import ci-dessous dit quelles feuilles
// arrivent avec quel module ; une fenêtre ne doit rien prendre à une feuille qui n'arrive pas
// avec elle.

const RENDERER_SRC = path.join(ROOT, 'src/renderer/src');
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['@backend/', path.join(ROOT, 'backend') + path.sep],
  ['@shared/', path.join(ROOT, 'src/shared') + path.sep],
  ['@/', path.join(ROOT, 'src') + path.sep],
];
const SUFFIXES = ['', '.tsx', '.ts', '/index.tsx', '/index.ts'];

function resolveSpecifier(from: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith('.')) {
    base = path.resolve(path.dirname(from), spec);
  } else {
    const alias = ALIASES.find(([prefix]) => spec.startsWith(prefix));
    if (alias) base = alias[1] + spec.slice(alias[0].length);
  }
  if (base === null) return null; // un paquet de node_modules
  for (const suffix of SUFFIXES) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface ModuleImports {
  readonly eager: string[];
  readonly onDemand: string[];
}
const importCache = new Map<string, ModuleImports>();

/** Les modules qu'un fichier importe : statiquement (chargés avec lui) ou par `import()`. */
function importsOf(file: string): ModuleImports {
  const cached = importCache.get(file);
  if (cached) return cached;
  const result: ModuleImports = { eager: [], onDemand: [] };
  if (/\.tsx?$/.test(file)) {
    const code = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1')
      // Un import de type disparaît à la compilation : il ne charge rien.
      .replace(/\b(?:import|export)\s+type\b[^;]*?\bfrom\s*['"][^'"]+['"]/g, '');
    const add = (list: string[], spec: string): void => {
      const resolved = resolveSpecifier(file, spec);
      if (resolved) list.push(resolved);
    };
    for (const m of code.matchAll(/\b(?:import|export)\b[^;'"()]*?\bfrom\s*['"]([^'"]+)['"]/g)) add(result.eager, m[1]);
    for (const m of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) add(result.eager, m[1]);
    for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) add(result.onDemand, m[1]);
  }
  importCache.set(file, result);
  return result;
}

/** Tout ce qu'un module charge avec lui, feuilles comprises. */
function staticClosure(starts: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    stack.push(...importsOf(file).eager);
  }
  return seen;
}

/** Les modules chargés au démarrage, et, pour chaque `import()`, ce qu'il apporte en plus. */
function loadGraph(): { atStartup: Set<string>; onDemand: Map<string, Set<string>> } {
  const atStartup = staticClosure([ENTRY]);
  const onDemand = new Map<string, Set<string>>();
  const pending = [...atStartup].flatMap((f) => importsOf(f).onDemand);
  while (pending.length > 0) {
    const root = pending.pop() as string;
    if (onDemand.has(root) || atStartup.has(root)) continue;
    const loaded = new Set([...staticClosure([root])].filter((f) => !atStartup.has(f)));
    onDemand.set(root, loaded);
    for (const f of loaded) pending.push(...importsOf(f).onDemand);
  }
  return { atStartup, onDemand };
}

const intersect = (sets: ReadonlyArray<ReadonlySet<string>>): Set<string> =>
  sets.length === 0 ? new Set() : new Set([...sets[0]].filter((x) => sets.every((s) => s.has(x))));

/**
 * Ce qui est chargé à coup sûr quand un module l'est : le démarrage, et ce qu'apporte chacun des
 * `import()` qui peuvent l'amener, avec ce qu'avaient déjà chargé les modules qui les appellent
 * (un graphique chargé à la demande par un panneau, lui-même chargé à la demande, arrive avec
 * la feuille du panneau). `null` : un module que rien ne charge.
 */
function guaranteedLoads(graph: ReturnType<typeof loadGraph>): (module: string) => Set<string> | null {
  const { atStartup, onDemand } = graph;
  const modules = [...atStartup, ...[...onDemand.values()].flatMap((mods) => [...mods])];
  const byRoot = (root: string, visiting: Set<string>): Set<string> => {
    const own = new Set([...atStartup, ...staticClosure([root])]);
    if (visiting.has(root)) return own;
    const next = new Set(visiting).add(root);
    const callers = [...new Set(modules.filter((m) => importsOf(m).onDemand.includes(root)))];
    const inherited = intersect(callers.map((m) => byModule(m, next) ?? new Set<string>()));
    return new Set([...own, ...inherited]);
  };
  const byModule = (module: string, visiting: Set<string>): Set<string> | null => {
    if (atStartup.has(module)) return atStartup;
    const carriers = [...onDemand].filter(([, mods]) => mods.has(module)).map(([root]) => root);
    if (carriers.length === 0) return null;
    return intersect(carriers.map((root) => byRoot(root, visiting)));
  };
  return (module) => byModule(module, new Set());
}

/** Les classes qu'un composant écrit dans ses `className` (chaînes et gabarits). */
function classNamesOf(tsx: string): Set<string> {
  const code = fs.readFileSync(tsx, 'utf8');
  const classes = new Set<string>();
  const addTokens = (text: string): void => {
    for (const t of text.matchAll(/[A-Za-z_][\w-]*/g)) classes.add(t[0]);
  };
  for (const m of code.matchAll(/className=/g)) {
    let i = (m.index ?? 0) + m[0].length;
    if (code[i] === '"' || code[i] === "'") {
      const end = code.indexOf(code[i], i + 1);
      addTokens(code.slice(i + 1, end));
      continue;
    }
    if (code[i] !== '{') continue;
    let depth = 0;
    const start = i;
    for (; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}' && --depth === 0) break;
    }
    for (const lit of code.slice(start, i).matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
      addTokens(lit[1] ?? lit[2] ?? lit[3] ?? '');
    }
  }
  return classes;
}

/** Les classes qu'un élément doit porter pour qu'un sélecteur le touche (hors `:not(…)`). */
function requiredClasses(selector: string): string[] {
  const bare = selector.replace(/:not\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '');
  return [...bare.matchAll(/\.([A-Za-z_-][\w-]*)/g)].map((m) => m[1]);
}

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') tsxFiles(p, out);
    } else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
      out.push(p);
    }
  }
  return out;
}

/** Une fenêtre : un composant qui pose le cadre commun (`modal-overlay` ou `modal-content`). */
const WINDOW_FRAME = /^modal-(?:overlay|content)$/;

const graph = loadGraph();
const guaranteed = guaranteedLoads(graph);
const lazySheets = new Set(
  [...graph.onDemand.values()].flatMap((mods) => [...mods].filter((f) => f.endsWith('.css'))),
);
const rel = (f: string): string => path.relative(ROOT, f);
const component = (name: string): string => path.join(RENDERER_SRC, 'components', name);
const short = (f: string): string => path.relative(path.join(RENDERER_SRC, 'components'), f);

/** La feuille arrive avec le composant, chaque fois qu'il arrive. */
function comesWith(sheet: string, comp: string): boolean {
  return guaranteed(comp)?.has(sheet) ?? false;
}

/** Les règles des feuilles chargées à la demande qui peuvent toucher un composant sans arriver avec lui. */
function lazyReach(components: readonly string[]): string[] {
  const found: string[] = [];
  for (const comp of components) {
    const classes = classNamesOf(comp);
    for (const sheet of lazySheets) {
      if (comesWith(sheet, comp)) continue;
      for (const selector of selectors(fs.readFileSync(sheet, 'utf8'))) {
        const required = requiredClasses(selector);
        if (required.length > 0 && required.every((c) => classes.has(c))) {
          found.push(`${short(comp)} ← ${short(sheet)}: ${selector}`);
        }
      }
    }
  }
  // Deux règles au même sélecteur dans une feuille : une entrée.
  return [...new Set(found)].sort();
}

describe('fenêtres modales : rien ne leur vient d’un panneau ouvert avant elles', () => {
  const windows = tsxFiles(RENDERER_SRC).filter((f) => [...classNamesOf(f)].some((c) => WINDOW_FRAME.test(c)));

  it('le graphe voit les feuilles chargées à la demande et les fenêtres', () => {
    expect([...lazySheets].map(rel)).toEqual(
      expect.arrayContaining([
        'src/renderer/src/components/PrimarySources/OCRSettingsModal.css',
        'src/renderer/src/components/PrimarySources/PrimarySourceStats.css',
        'src/renderer/src/components/Methodology/MethodologyModal.css',
      ]),
    );
    expect(lazySheets.has(component('Bibliography/BibImportModeModal.css'))).toBe(false);
    expect(windows.map(rel)).toEqual(
      expect.arrayContaining([
        'src/renderer/src/components/Bibliography/BibImportModeModal.tsx',
        'src/renderer/src/components/Bibliography/BibImportSummaryModal.tsx',
        'src/renderer/src/components/Bibliography/OrphanPDFModal.tsx',
        'src/renderer/src/components/PrimarySources/OCRSettingsModal.tsx',
        'src/renderer/src/components/Methodology/MethodologyModal.tsx',
      ]),
    );
    // La feuille des statistiques des Sources primaires arrive avec la fenêtre de l'OCR (même
    // panneau), pas avec le choix d'import d'un `.bib`, chargé au démarrage.
    const stats = component('PrimarySources/PrimarySourceStats.css');
    expect(comesWith(stats, component('PrimarySources/OCRSettingsModal.tsx'))).toBe(true);
    expect(comesWith(stats, component('Bibliography/BibImportModeModal.tsx'))).toBe(false);
    // Une portée sous `:where(…)` compte ; une classe sous `:not(…)` n'est pas exigée.
    expect(requiredClasses(':where(.ocr-settings-modal) .btn-primary:hover:not(:disabled)')).toEqual(['ocr-settings-modal', 'btn-primary']);
    expect(requiredClasses('.stat-item:not(.success) .stat-label')).toEqual(['stat-item', 'stat-label']);
  });

  it('aucune règle d’une feuille chargée à la demande ne touche une fenêtre qui ne la charge pas', () => {
    expect(lazyReach(windows)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tous les composants (J13).

/** Les feuilles qui valent pour toute l'app, chargées au démarrage. */
const GLOBAL_SHEETS = new Set([path.join(RENDERER_SRC, 'index.css'), COMMON_SHEET]);

/** Classes de contexte posées sur un ancêtre (thème, densité) : elles ne disent pas le composant. */
const CONTEXT_CLASSES = new Set(['dark', 'light', 'theme-dark', 'theme-light', 'density-compact']);

/**
 * Les classes d'ancrage d'un sélecteur : celles de son premier sélecteur composé, `:where(…)`
 * compris, après un éventuel contexte de thème (`.dark .tag-manager` s'ancre sur
 * `tag-manager`). Vide quand le sélecteur s'ancre sur un élément ou un id.
 */
function anchorClasses(selector: string): string[] {
  for (const compound of splitTopLevel(selector, /[\s>+~]/)) {
    if (/#[A-Za-z]/.test(compound.replace(/\([^)]*\)/g, ''))) return [];
    const classes = requiredClasses(compound);
    if (/^(?:html|body|:root)(?![\w-])/.test(compound) || (classes.length > 0 && classes.every((c) => CONTEXT_CLASSES.has(c)))) {
      continue;
    }
    return [...new Set(classes.filter((c) => !CONTEXT_CLASSES.has(c)))].sort();
  }
  return [];
}

/** Les ancrages partagés par deux feuilles ou plus, hors des feuilles globales. */
function sharedAnchors(): string[] {
  const sheetsByAnchor = new Map<string, Set<string>>();
  for (const sheet of walk(RENDERER_SRC)) {
    if (GLOBAL_SHEETS.has(sheet)) continue;
    for (const selector of selectors(fs.readFileSync(sheet, 'utf8'))) {
      const anchor = anchorClasses(selector);
      if (anchor.length === 0) continue;
      const key = `.${anchor.join('.')}`;
      sheetsByAnchor.set(key, (sheetsByAnchor.get(key) ?? new Set()).add(short(sheet)));
    }
  }
  return [...sheetsByAnchor]
    .filter(([, sheets]) => sheets.size >= 2)
    .map(([key, sheets]) => `${key}: ${[...sheets].sort().join(', ')}`)
    .sort();
}

// Stock connu, à réduire ; aucune entrée nouvelle. Relevé le 2026-11-15 (J13). Une entrée
// corrigée sort de la liste dans la même PR (le test le demande) ; une entrée nouvelle se
// corrige, elle ne s'ajoute pas ici. Une entrée : « ancrage : feuilles qui l'emploient ».
const KNOWN_SHARED_ANCHORS: readonly string[] = [
  // Statistiques de la bibliographie, panneaux du corpus, journal.
  '.active.tab-button: Bibliography/BibliographyStats.css, Corpus/TextometricsPanel.css',
  '.tab-button: Bibliography/BibliographyStats.css, Corpus/TextometricsPanel.css',
  '.legend-color: Bibliography/BibliographyStats.css, Corpus/CorpusExplorerPanel.css',
  '.legend-item: Bibliography/BibliographyStats.css, Corpus/CorpusExplorerPanel.css',
  '.stat-info: Bibliography/BibliographyStats.css, Corpus/CorpusExplorerPanel.css',
  '.timeline-item: Bibliography/BibliographyStats.css, Journal/JournalPanel.css',
  '.stat-label: Bibliography/BibImportSummaryModal.css, Bibliography/BibliographyStats.css, Bibliography/OrphanPDFModal.css',
  '.stat-value: Bibliography/BibImportSummaryModal.css, Bibliography/BibliographyStats.css, Bibliography/OrphanPDFModal.css',
  // Bibliographie et Sources primaires.
  '.btn-cancel: Bibliography/BibImportModeModal.css, Bibliography/PDFSelectionDialog.css',
  '.search-box: Bibliography/BibliographyPanel.css, PrimarySources/PrimarySourcesPanel.css',
  '.form-group: PrimarySources/OCRSettingsModal.css, PrimarySources/TranscriptionImportModal.css',
  // Journal, chat, corpus, projets.
  '.empty-state: Journal/JournalPanel.css, Project/ProjectPanel.css',
  '.loading-spinner: Corpus/CorpusExplorerPanel.css, Journal/JournalPanel.css',
  '.message-content: Chat/MessageBubble.css, Journal/JournalPanel.css',
  '.message-header: Chat/MessageBubble.css, Journal/JournalPanel.css',
  '.message-role: Chat/MessageBubble.css, Journal/JournalPanel.css',
  '.message-sources: Chat/MessageBubble.css, Journal/JournalPanel.css',
  '.message-time: Chat/MessageBubble.css, Journal/JournalPanel.css',
  // Réglages et configuration des présentations.
  '.checkbox-label: PrimarySources/OCRSettingsModal.css, Project/BeamerConfig.css, Project/PresentationConfig.css',
  '.config-header: Config/ConfigPanel.css, Project/BeamerConfig.css, Project/PresentationConfig.css',
  '.config-saving: Project/BeamerConfig.css, Project/PresentationConfig.css',
  '.config-section: Config/ConfigPanel.css, Project/BeamerConfig.css, Project/PresentationConfig.css',
  '.settings-content: Chat/RAGSettingsPanel.css, Config/SettingsModal.css',
];

// Stock connu, à réduire ; aucune entrée nouvelle. Même relevé, mêmes règles. Une entrée :
// « composant ← feuille chargée à la demande : sélecteur qui peut l'atteindre ».
const KNOWN_LAZY_REACH: readonly string[] = [
  // PrimarySources/PrimarySourcesPanel.css
  'Bibliography/BibliographyPanel.tsx ← PrimarySources/PrimarySourcesPanel.css: .search-box',
  'Bibliography/BibliographyPanel.tsx ← PrimarySources/PrimarySourcesPanel.css: .search-box .search-icon',
  'Bibliography/BibliographyPanel.tsx ← PrimarySources/PrimarySourcesPanel.css: .search-box input',
  'Bibliography/BibliographyPanel.tsx ← PrimarySources/PrimarySourcesPanel.css: .search-box input::placeholder',
  'Bibliography/BibliographyPanel.tsx ← PrimarySources/PrimarySourcesPanel.css: .search-box input:focus',
  // Corpus/CorpusExplorerPanel.css
  'Bibliography/BibliographyStats.tsx ← Corpus/CorpusExplorerPanel.css: .legend-color',
  'Bibliography/BibliographyStats.tsx ← Corpus/CorpusExplorerPanel.css: .legend-item',
  'Bibliography/BibliographyStats.tsx ← Corpus/CorpusExplorerPanel.css: .stat-info',
  'Corpus/TextometricsPanel.tsx ← Corpus/CorpusExplorerPanel.css: .loading-spinner',
  'Journal/JournalPanel.tsx ← Corpus/CorpusExplorerPanel.css: .loading-spinner',
  // Corpus/TextometricsPanel.css
  'Bibliography/BibliographyStats.tsx ← Corpus/TextometricsPanel.css: .tab-button',
  'Bibliography/BibliographyStats.tsx ← Corpus/TextometricsPanel.css: .tab-button.active',
  'Bibliography/BibliographyStats.tsx ← Corpus/TextometricsPanel.css: .tab-button:hover',
  // Journal/JournalPanel.css
  'Bibliography/BibliographyStats.tsx ← Journal/JournalPanel.css: .timeline-item',
  'Chat/MessageBubble.tsx ← Journal/JournalPanel.css: .message-content',
  'Chat/MessageBubble.tsx ← Journal/JournalPanel.css: .message-header',
  'Chat/MessageBubble.tsx ← Journal/JournalPanel.css: .message-role',
  'Chat/MessageBubble.tsx ← Journal/JournalPanel.css: .message-time',
  'Corpus/CorpusExplorerPanel.tsx ← Journal/JournalPanel.css: .loading-spinner',
  'Corpus/TextometricsPanel.tsx ← Journal/JournalPanel.css: .loading-spinner',
  'Project/ProjectPanel.tsx ← Journal/JournalPanel.css: .empty-state',
  // Methodology/MethodologyModal.css
  'Bibliography/BibliographyStats.tsx ← Methodology/MethodologyModal.css: .overview h2',
  'Bibliography/BibliographyStats.tsx ← Methodology/MethodologyModal.css: .overview h3',
  // Config/SettingsModal.css
  'Chat/RAGSettingsPanel.tsx ← Config/SettingsModal.css: .settings-content',
];

describe('tous les composants : une feuille ne touche que le sien (J13)', () => {
  const components = tsxFiles(RENDERER_SRC).filter((f) => guaranteed(f) !== null);

  it('le repérage voit les composants, les ancrages et ce qui arrive avec un panneau', () => {
    expect(components.length).toBeGreaterThan(100);
    expect(anchorClasses('.form-field label')).toEqual(['form-field']);
    expect(anchorClasses(':where(.export-modal) .form-field input:not([type="checkbox"])')).toEqual(['export-modal']);
    expect(anchorClasses('.modal-content.bib-import-mode-modal')).toEqual(['bib-import-mode-modal', 'modal-content']);
    expect(anchorClasses('.dark .tag-manager')).toEqual(['tag-manager']);
    expect(anchorClasses('body.theme-dark .stat-value')).toEqual(['stat-value']);
    expect(anchorClasses('#root .x')).toEqual([]);
    expect(anchorClasses('button:hover')).toEqual([]);
    expect(splitTopLevel(':where(.a, .b) .c, .d', /,/)).toEqual([':where(.a, .b) .c', '.d']);
    // Un graphique chargé à la demande par le panneau du corpus, lui-même chargé à la demande,
    // arrive avec la feuille de ce panneau.
    expect(
      comesWith(component('Corpus/CorpusExplorerPanel.css'), component('Corpus/TopicTimeline.tsx')),
    ).toBe(true);
    // « Signaler un problème » et les fenêtres d'export sont chargées à la demande, chacune de
    // son côté : la feuille de l'une n'arrive pas avec l'autre.
    expect(comesWith(component('Export/PDFExportModal.css'), component('Report/ReportIssueModal.tsx'))).toBe(false);
    expect(comesWith(component('Export/PDFExportModal.css'), component('Export/WordExportModal.tsx'))).toBe(true);
  });

  it('aucune classe ne s’ancre dans deux feuilles hors du stock connu', () => {
    const found = sharedAnchors();
    expect(found.filter((e) => !KNOWN_SHARED_ANCHORS.includes(e))).toEqual([]);
    // Une entrée corrigée sort de l'inventaire.
    expect(KNOWN_SHARED_ANCHORS.filter((e) => !found.includes(e))).toEqual([]);
  });

  it('aucune règle d’une feuille chargée à la demande n’atteint un composant qu’elle n’accompagne pas, hors du stock connu', () => {
    const found = lazyReach(components);
    expect(found.filter((e) => !KNOWN_LAZY_REACH.includes(e))).toEqual([]);
    expect(KNOWN_LAZY_REACH.filter((e) => !found.includes(e))).toEqual([]);
  });

  it('les trois fenêtres d’export portent la racine de leur feuille commune et l’importent', () => {
    for (const name of ['PDFExportModal', 'WordExportModal', 'PresentationExportModal']) {
      const file = component(`Export/${name}.tsx`);
      expect(classNamesOf(file).has('export-modal'), name).toBe(true);
      expect(staticClosure([file]).has(component('Export/ExportModal.css')), name).toBe(true);
    }
  });
});
