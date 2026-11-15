// @vitest-environment jsdom
/**
 * J13 : la règle des champs des fenêtres d'export (`width: 100%`, `ExportModal.css`) étirait
 * aussi la case du moteur de citation, posée dans un `.form-field` : la case au milieu de la
 * ligne, son libellé repoussé à droite. La règle ne vise plus les cases à cocher.
 *
 * jsdom ne met rien en page : le test lit la valeur déclarée que la feuille donne à chaque
 * champ (la case n'en reçoit aucune, les listes reçoivent `100%`), pas une largeur rendue. Les
 * captures de la PR font foi pour l'allure.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { ExportCitationSection } from '../ExportCitationSection';

const SHEET = fs.readFileSync(path.join(__dirname, '../ExportModal.css'), 'utf8');

afterEach(() => {
  cleanup();
  document.head.querySelectorAll('style[data-test-sheet]').forEach((s) => s.remove());
});

describe('case du moteur de citation dans une fenêtre d’export', () => {
  it('garde sa taille ; les listes du moteur prennent la largeur du champ', () => {
    const style = document.createElement('style');
    style.dataset.testSheet = 'ExportModal.css';
    style.textContent = SHEET;
    document.head.appendChild(style);

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
    // La feuille est bien lue : les listes du même bloc reçoivent la règle des champs.
    for (const id of ['export-citation-style', 'export-citation-locale']) {
      expect(getComputedStyle(document.getElementById(id) as HTMLElement).width).toBe('100%');
    }
  });
});
