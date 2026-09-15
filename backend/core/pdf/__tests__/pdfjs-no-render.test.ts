/**
 * Invariant de sécurité : ClioDeck lit le texte des PDF, il ne les rend jamais.
 *
 * Le rendu canvas de pdfjs (`page.render()`) est la voie par laquelle une
 * police piégée exécutait du code (CVE-2024-4367, 3.x). L'extraction de texte
 * n'y passe pas ; c'est ce qui rendait la faille inatteignable ici, et rien ne
 * le gardait. Ce test le garde :
 *
 *  1. seul `pdfjs-loader.ts` charge pdfjs-dist à l'exécution (les `import type`
 *     restent libres) — un point d'entrée unique, où vivent les options
 *     d'ouverture et les classes de remplacement du rendu ;
 *  2. aucun fichier de `src/` ni de `backend/` n'appelle `.render(` sur un
 *     objet pdfjs.
 *
 * Ajouter un aperçu rendu de PDF est une décision de sécurité, pas un détail :
 * elle doit passer par la modification explicite de ce test.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Le code sans ses commentaires : un commentaire qui *nomme* render() n'est pas un appel. */
const code = (f: string) =>
  fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const files = ['src', 'backend'].flatMap((d) => sourceFiles(path.join(repoRoot, d)));
const rel = (f: string) => path.relative(repoRoot, f);

/** Import à l'exécution de pdfjs-dist : statique, dynamique ou require — pas `import type`. */
const RUNTIME_PDFJS_IMPORT =
  /(?:^|\n)\s*import\s+(?!type\b)[^;]*?from\s+['"]pdfjs-dist[^'"]*['"]|import\(\s*['"]pdfjs-dist|require\(\s*['"]pdfjs-dist/;

describe('pdfjs-dist : lecture de texte seulement, jamais de rendu', () => {
  it('ne charge pdfjs-dist qu’à travers pdfjs-loader.ts', () => {
    expect(files.length).toBeGreaterThan(100);
    const loaders = files.filter((f) => RUNTIME_PDFJS_IMPORT.test(code(f))).map(rel);
    expect(loaders).toEqual([path.join('backend', 'core', 'pdf', 'pdfjs-loader.ts')]);
  });

  it('n’appelle jamais render() sur une page PDF', () => {
    const offenders = files
      .filter((f) => {
        const src = code(f);
        const touchesPdfjs = /pdfjs-dist|pdfjs-loader|PDFPageProxy|getPage\(/.test(src);
        return touchesPdfjs && /\.render\s*\(/.test(src);
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
