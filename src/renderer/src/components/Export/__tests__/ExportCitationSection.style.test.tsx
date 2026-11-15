// @vitest-environment jsdom
/**
 * J13 : la règle des champs des fenêtres d'export (`width: 100%`, `ExportModal.css`) étirait
 * aussi la case du moteur de citation, posée dans un `.form-field` : la case au milieu de la
 * ligne, son libellé repoussé à droite. La règle ne vise plus les cases à cocher.
 *
 * La case ne tient que si aucune autre feuille ne l'étire. Jusqu'à J13, `ProjectPanel.css`,
 * chargée au démarrage, posait sans portée `.form-field input { width: 100% }` : la case
 * s'étirait encore, même avec la bonne règle dans `ExportModal.css`. Le test charge donc, avant
 * `ExportModal.css`, toutes les feuilles du renderer et de l'éditeur : celles du démarrage, et
 * celles des panneaux qu'on a pu ouvrir avant la fenêtre d'export (revue de J13).
 *
 * jsdom ne met rien en page : le test lit la valeur déclarée que les feuilles donnent à chaque
 * champ (la case n'en reçoit aucune, les listes reçoivent `100%`), pas une largeur rendue. Les
 * captures de la PR font foi pour l'allure.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { ExportCitationSection } from '../ExportCitationSection';

const ROOT = path.resolve(__dirname, '../../../../../..');
const EXPORT_SHEET = path.join(__dirname, '../ExportModal.css');

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

/** Toutes les feuilles de l'app, `index.css` en tête et `ExportModal.css` en dernier. */
function appSheets(): string[] {
  const index = path.join(ROOT, 'src/renderer/src/index.css');
  const others = [...walk(path.join(ROOT, 'src/renderer/src')), ...walk(path.join(ROOT, 'src/editor'))]
    .filter((p) => p !== index && p !== EXPORT_SHEET)
    .sort();
  return [index, ...others, EXPORT_SHEET];
}

function inject(file: string): void {
  const style = document.createElement('style');
  style.dataset.testSheet = path.relative(ROOT, file);
  style.textContent = fs.readFileSync(file, 'utf8');
  document.head.appendChild(style);
  // jsdom écarte en silence une feuille qu'il ne sait pas lire : elle ne compterait pour rien.
  expect(style.sheet?.cssRules.length ?? 0, style.dataset.testSheet).toBeGreaterThan(0);
}

afterEach(() => {
  cleanup();
  document.head.querySelectorAll('style[data-test-sheet]').forEach((s) => s.remove());
});

describe('case du moteur de citation dans une fenêtre d’export', () => {
  it('garde sa taille, quelles que soient les feuilles chargées avant ; les listes du moteur prennent la largeur du champ', () => {
    const sheets = appSheets();
    expect(sheets).toContain(path.join(ROOT, 'src/renderer/src/components/Project/ProjectPanel.css'));
    sheets.forEach(inject);

    render(
      <div className="export-modal">
        <ExportCitationSection
          value={{ useEngine: true, style: 'chicago-note-bibliography', locale: 'fr-FR' }}
          onChange={() => undefined}
        />
      </div>,
    );

    const toggle = screen.getByTestId('export-citation-toggle');
    expect(getComputedStyle(toggle).width).not.toBe('100%');
    // Les feuilles sont bien lues : les listes du même bloc reçoivent la règle des champs.
    for (const id of ['export-citation-style', 'export-citation-locale']) {
      expect(getComputedStyle(document.getElementById(id) as HTMLElement).width).toBe('100%');
    }
  });
});
