/**
 * Aucun émoji ni glyphe typographique ne tient lieu d'icône.
 *
 * Le jeu d'icônes de l'application est lucide (`lucide-react` dans les
 * composants, `lucide` dans les widgets CodeMirror de `src/editor`). Jusqu'au
 * 2026-10-28, une soixantaine d'émojis (📁, 🔍, ⚙️, 🤖…) et de glyphes
 * (✓, ✗, ▶, ▼, ✕, ➤, ↑, ↓) en faisaient office dans le JSX, les feuilles de
 * style (`content: "📁"`) et les traductions : rendu dépendant de la police
 * du système, couleur impossible à régler, pas de taille contrôlée. Ce
 * garde-fou empêche leur retour.
 *
 * Sont ignorés : les journaux (`console.*`), les commentaires, et les
 * flèches de prose (→ ←), qui ne sont pas des icônes.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const SCANNED_DIRS = [
  path.join(ROOT, 'src/renderer/src'),
  path.join(ROOT, 'src/editor'),
];
const LOCALES = ['fr', 'en', 'de'].map((l) => path.join(ROOT, 'public/locales', l, 'common.json'));

/** Pictogrammes et symboles qui ont servi d'icônes : émojis, dingbats, formes, flèches épaisses, « misc technical ». */
const PICTO =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2190}-\u{2191}\u{2193}-\u{21FF}]/u;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(p, out);
    } else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

function offendingLines(file: string): string[] {
  const hits: string[] = [];
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (/console\.(log|warn|error|info|debug)\(/.test(line)) return;
      if (PICTO.test(line)) hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${trimmed.slice(0, 100)}`);
    });
  return hits;
}

describe('icônes : lucide seulement', () => {
  it('aucun émoji ou glyphe-icône dans les composants, l’éditeur et le CSS', () => {
    const files = SCANNED_DIRS.flatMap((d) => walk(d));
    expect(files.length).toBeGreaterThan(200);
    const found = files.flatMap(offendingLines);
    expect(found).toEqual([]);
  });

  it('aucun émoji ou glyphe-icône dans les traductions', () => {
    const found = LOCALES.flatMap(offendingLines);
    expect(found).toEqual([]);
  });
});
