/**
 * Aucune chaîne visible ne doit être codée en dur dans un composant.
 *
 * Le test qui existait ne cherchait que du FRANÇAIS, et seulement dans
 * `components/Export/` — six fichiers sur environ cent quatre-vingts. Il
 * n'a donc rien vu quand la modale des réglages OCR, celle de l'import de
 * transcriptions, toute la Configuration RAG et une bonne part de la
 * bibliothèque sont restées intraduisibles. Une chaîne anglaise en dur est
 * exactement aussi intraduisible qu'une française : ce garde-fou ne
 * regarde plus la langue, mais le fait qu'un texte visible n'appelle pas
 * `t()`.
 *
 * Il couvre les deux endroits où une chaîne d'interface apparaît :
 *   >  Texte  <          (nœud de texte JSX)
 *   title="Texte"        (attribut vu par l'utilisateur)
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const COMPONENTS = path.resolve(__dirname, '../components');

const JSX_TEXT = />\s*([A-Za-zÀ-ÿ][^<>{}\n]*[A-Za-zÀ-ÿ.!?…])\s*</g;
const ATTR = /\b(?:title|placeholder|aria-label|alt|label)\s*=\s*"([^"]+)"/g;

/** Ni prose ni libellé : nombres, identifiants, unités, URL. */
const NOT_PROSE =
  /^(?:[\d\s.,:;/%+×—–-]+|[A-Za-z]+(?:[-_.][A-Za-z0-9]+)+|https?:\/\/\S+|\S+@\S+|[A-Z_]{2,}|\d+\s*(?:px|rem|em|%|ms|s|Ko|Mo|Go|KB|MB|GB))$/;

/** Fragments d'annotations de type attrapés par la regex JSX. */
const TYPEISH = /^(?:void|Promise|string|number|boolean|unknown|any)(?:\s*\|\s*\w+)*$/;

/**
 * Noms propres, vocabulaire technique et endonymes : à laisser tels quels.
 *
 * Chaque entrée est un choix, pas un oubli. Les endonymes du sélecteur de
 * langue ne se traduisent jamais — un germanophone cherche « Deutsch ».
 * Le vocabulaire YAML des recettes appartient au format, comme du code.
 * Les amorces de clé d'API (`sk-ant-…`) sont des formats, pas des phrases.
 */
const ALLOWED = new Set([
  // Produits, formats, outils
  'ClioDeck', 'ClioBrain', 'Zotero', 'Tropy', 'Obsidian', 'Ollama', 'Anthropic',
  'Claude', 'OpenAI', 'Mistral', 'Gemini', 'Google', 'BibTeX', 'LaTeX', 'Markdown',
  'PDF', 'DOCX', 'JSON', 'YAML', 'CSL', 'MCP', 'RAG', 'BERTopic', 'Transkribus',
  'pandoc', 'xelatex', 'Europeana', 'GitHub', 'Electron',
  'Transkribus Export', 'ALTO XML', 'PAGE XML', 'prompt injection',
  'User ID', 'API Key', 'Frédéric Clavert',
  // Polices — noms propres
  'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'Cascadia Code',
  'Prose', 'Monospace',
  // Endonymes : jamais traduits.
  'Français', 'English', 'Deutsch',
  // Thèmes et transitions reveal.js — noms propres du produit.
  'White', 'League', 'Beige', 'Sky', 'Black', 'Simple', 'Serif', 'Blood',
  'Moon', 'Night', 'Solarized', 'Dracula',
  'None', 'Fade', 'Slide', 'Convex', 'Concave', 'Zoom',
  // Vocabulaire YAML du format de recettes : c'est la syntaxe, pas de la prose.
  'key', 'description', 'with', 'key: value',
  // Formats de clés d'API et noms de modèles.
  'sk-ant-…', 'sk-…', 'AIza…', 'o1-mini', 'gemma2:2b',
]);

function isVisibleProse(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 3) return false;
  if (ALLOWED.has(t) || NOT_PROSE.test(t) || TYPEISH.test(t)) return false;
  return /[A-Za-zÀ-ÿ]{2}/.test(t);
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(full);
    return e.name.endsWith('.tsx') ? [full] : [];
  });
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

function scan(): Finding[] {
  const out: Finding[] = [];
  for (const file of walk(COMPONENTS)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const re of [JSX_TEXT, ATTR]) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        if (!isVisibleProse(m[1])) continue;
        out.push({
          file: path.relative(COMPONENTS, file),
          line: src.slice(0, m.index).split('\n').length,
          text: m[1].trim(),
        });
      }
    }
  }
  return out;
}

describe('aucune chaîne visible codée en dur', () => {
  it('détecte bien quelque chose quand on lui en donne (garde-fou du test)', () => {
    // Sans cela, une regex cassée rendrait le test vert en ne voyant rien.
    expect(isVisibleProse('Enregistrer les modifications')).toBe(true);
    expect(isVisibleProse('Save changes')).toBe(true);
    expect(isVisibleProse('Fermer')).toBe(true);
  });

  it('ne se déclenche pas sur ce qui n’est pas de la prose', () => {
    for (const ok of ['Zotero', '1.0.0', 'sk-ant-…', 'gemma2:2b', '12 px', 'Deutsch']) {
      expect(isVisibleProse(ok)).toBe(false);
    }
  });

  it('parcourt bien l’ensemble des composants', () => {
    expect(walk(COMPONENTS).length).toBeGreaterThan(100);
  });

  it('n’en trouve aucune', () => {
    const found = scan().map((f) => `${f.file}:${f.line}  ${f.text}`);
    expect(found).toEqual([]);
  });
});
