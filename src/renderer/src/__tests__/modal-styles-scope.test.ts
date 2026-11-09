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
