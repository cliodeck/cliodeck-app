/**
 * La superposition passe par une échelle déclarée, jamais par un nombre.
 *
 * Le dépôt employait 1, 10, 40, 100, 900, 1000, 1100, 9000, 9999 et 10000
 * au jugé, chaque composant choisissant le sien. Deux panneaux flottants
 * voisins se sont ainsi retrouvés à 1000 et 40 : celui des brouillons
 * disparaissait derrière celui des similarités, alors que son bouton
 * restait en état actif — rien à l'écran ne disait ce qui s'était passé.
 *
 * Une échelle ne tient que si rien ne la contourne : ce test échoue dès
 * qu'une feuille de style réintroduit une valeur brute.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const RENDERER = path.resolve(__dirname, '..');
const INDEX_CSS = path.join(RENDERER, 'index.css');

/**
 * Valeurs brutes tolérées : elles créent un contexte d'empilement LOCAL
 * (une pastille au-dessus de son trait, par exemple) et ne participent pas
 * à la hiérarchie globale des surfaces.
 */
const LOCAL_STACKING = new Set(['0', '1', '2', '-1', 'auto']);

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return cssFiles(full);
    return e.name.endsWith('.css') ? [full] : [];
  });
}

describe('échelle de superposition', () => {
  const tokens = (() => {
    const src = fs.readFileSync(INDEX_CSS, 'utf8');
    const found = new Map<string, number>();
    for (const m of src.matchAll(/^\s*(--z-[\w-]+):\s*(\d+);/gm)) {
      found.set(m[1], Number(m[2]));
    }
    return found;
  })();

  it('est déclarée dans index.css', () => {
    expect(tokens.size).toBeGreaterThanOrEqual(6);
    for (const name of ['--z-docked', '--z-floating', '--z-modal', '--z-dialog']) {
      expect(tokens.has(name)).toBe(true);
    }
  });

  it('respecte l’ordre attendu des surfaces', () => {
    const order = [
      '--z-docked', '--z-dropdown', '--z-floating', '--z-chrome',
      '--z-modal', '--z-modal-raised', '--z-toast', '--z-dialog',
    ];
    const values = order.map((k) => tokens.get(k) ?? -1);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    // Un dialogue de confirmation s'ouvre DEPUIS une modale : il doit
    // passer au-dessus, sans quoi il serait invisible.
    expect(tokens.get('--z-dialog')!).toBeGreaterThan(tokens.get('--z-modal')!);
    // Un panneau flottant n'est pas une modale : il passe en dessous.
    expect(tokens.get('--z-floating')!).toBeLessThan(tokens.get('--z-modal')!);
  });

  it('n’est contournée par aucune feuille de style', () => {
    const offenders: string[] = [];
    for (const file of cssFiles(RENDERER)) {
      const src = fs.readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        // La déclaration des tokens eux-mêmes n'est pas un contournement.
        if (/^\s*--z-[\w-]+:/.test(line)) return;
        const m = line.match(/z-index:\s*([^;]+);/);
        if (!m) return;
        const value = m[1].trim();
        if (value.startsWith('var(--z-') || LOCAL_STACKING.has(value)) return;
        offenders.push(`${path.relative(RENDERER, file)}:${i + 1}  z-index: ${value}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('les deux panneaux flottants sont au même palier', () => {
    // C'est la régression d'origine : ils doivent partager le token.
    for (const rel of [
      'components/Similarity/SimilarityPanel.css',
      'components/Editor/DraftsPanel.css',
    ]) {
      const src = fs.readFileSync(path.join(RENDERER, rel), 'utf8');
      expect(src).toContain('z-index: var(--z-floating);');
    }
  });
});
