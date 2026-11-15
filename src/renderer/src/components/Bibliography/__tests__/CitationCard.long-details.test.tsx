// @vitest-environment jsdom
/**
 * Dans la fiche d'une référence, le libellé d'un détail long passe au-dessus de sa valeur (J4).
 *
 * Chaque détail était une ligne : le libellé, puis la valeur dans la colonne qui restait. À la largeur
 * par défaut du panneau, un résumé de 578 caractères y prenait 26 lignes en français ; en allemand,
 * « Zusammenfassung » laissait 101 px à la colonne, et la fiche faisait 824 px (39 lignes, boutons
 * coupés au bas de la fenêtre). Le champ d'étiquettes du projet, trop large pour sa colonne,
 * recouvrait « Projekt-Schlagwörter ». Le résumé, la note du `.bib`, les notes Zotero et les
 * étiquettes du projet ont donc leur libellé au-dessus ; les détails courts gardent la ligne.
 *
 * jsdom ne calcule pas de mise en page : le test charge la vraie feuille de la fiche et lit le style
 * calculé de chaque ligne. Les mesures dans l'app sont dans la PR.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { CitationCard } from '../CitationCard';
import type { Citation } from '../../../stores/bibliographyStore';

const ABSTRACT =
  "Ce livre retrace la construction des archives départementales françaises, de la loi du 5 brumaire an V à la veille de la Grande Guerre.";

const citation: Citation = {
  id: 'dupont2010',
  type: 'book',
  author: 'Dupont',
  year: '2010',
  title: 'Les archives de l’État',
  journal: 'Revue d’histoire',
  notes: 'Réimpr. 2015, avec une préface nouvelle',
  customFields: { abstract: ABSTRACT },
  zoteroNotes: [{ key: 'N1', text: 'Lu en 2019. Le chapitre 3 recoupe la série H.' }],
};

let sheet: HTMLStyleElement;

beforeAll(() => {
  sheet = document.createElement('style');
  sheet.textContent = readFileSync(path.resolve(__dirname, '../CitationCard.css'), 'utf8');
  document.head.appendChild(sheet);
});

afterAll(() => {
  sheet.remove();
});

afterEach(() => {
  cleanup();
});

async function expand(): Promise<void> {
  render(<CitationCard citation={citation} />);
  await act(async () => {
    fireEvent.click(screen.getByText('Dupont'));
  });
}

/** La ligne de détail qui porte ce libellé, et la direction de sa mise en page. */
function direction(label: string): string {
  const item = screen.getByText(label).closest('.detail-item');
  if (!(item instanceof HTMLElement)) throw new Error(`pas de ligne « ${label} »`);
  // Le libellé vient avant la valeur : en colonne, il est au-dessus.
  expect(item.firstElementChild?.classList.contains('detail-label')).toBe(true);
  return getComputedStyle(item).flexDirection;
}

describe('CitationCard : le libellé des détails longs', () => {
  it.each([
    ['le résumé', 'bibliography.abstract'],
    ['la note du .bib', 'bibliography.bibNote'],
    ['les notes Zotero', 'bibliography.zoteroNotes'],
    ['les étiquettes du projet', 'bibliography.projectTags'],
  ])('%s : libellé au-dessus de la valeur', async (_name, label) => {
    await expand();

    expect(direction(label)).toBe('column');
  });

  it.each([
    ['la clé', 'bibliography.citeKey'],
    ['la revue', 'bibliography.journal'],
  ])('témoin : %s garde la ligne libellé + valeur', async (_name, label) => {
    await expand();

    expect(direction(label)).not.toBe('column');
  });
});
