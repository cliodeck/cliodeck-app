/**
 * Les classes communes des fenêtres modales n'ont qu'une feuille : `components/common/Modal.css`,
 * chargée au démarrage.
 *
 * Jusqu'au 2026-11 (H1), `.modal-overlay`, `.modal-content`, `.modal-header`… n'étaient écrites
 * que dans la feuille de la fenêtre OCR, chargée avec le panneau Sources primaires, à la demande :
 * avant lui, le choix d'import d'un `.bib` s'affichait rogné en bas de la colonne de gauche. Et
 * d'autres feuilles propres à une fenêtre (Méthodologie, renommage de PDF, import BibTeX…)
 * posaient sans portée des règles sur ces mêmes classes : l'allure d'une fenêtre dépendait des
 * panneaux ouverts avant elle. Une règle propre à une fenêtre se pose sous la classe de sa fenêtre
 * (`.methodology-modal .modal-content`) ; ce garde-fou empêche le retour des règles sans portée.
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

/** Les sélecteurs des règles d'une feuille, un par élément de liste ; les règles `@` sont sautées. */
function selectors(css: string): string[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: string[] = [];
  for (const match of code.matchAll(/([^{};]+)\{/g)) {
    const prelude = match[1].trim();
    if (prelude.startsWith('@')) continue;
    found.push(...prelude.split(',').map((s) => s.trim()).filter(Boolean));
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

describe('fenêtres modales : rien ne leur vient d’un panneau ouvert avant elles', () => {
  const { onDemand } = loadGraph();
  const lazySheets = new Set([...onDemand.values()].flatMap((mods) => [...mods].filter((f) => f.endsWith('.css'))));
  const windows = tsxFiles(RENDERER_SRC).filter((f) => [...classNamesOf(f)].some((c) => WINDOW_FRAME.test(c)));
  const rel = (f: string): string => path.relative(ROOT, f);
  const component = (name: string): string => path.join(RENDERER_SRC, 'components', name);

  /** La feuille arrive avec la fenêtre : la fenêtre l'importe, ou tout panneau qui l'apporte l'apporte aussi. */
  function comesWith(sheet: string, win: string): boolean {
    if (staticClosure([win]).has(sheet)) return true;
    const carriers = [...onDemand.values()].filter((mods) => mods.has(win));
    return carriers.length > 0 && carriers.every((mods) => mods.has(sheet));
  }

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
    const found: string[] = [];
    for (const win of windows) {
      const classes = classNamesOf(win);
      for (const sheet of lazySheets) {
        if (comesWith(sheet, win)) continue;
        for (const selector of selectors(fs.readFileSync(sheet, 'utf8'))) {
          const required = requiredClasses(selector);
          if (required.length > 0 && required.every((c) => classes.has(c))) {
            found.push(`${path.basename(win)} ← ${rel(sheet)}: ${selector}`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  });
});
