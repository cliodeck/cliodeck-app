// @vitest-environment jsdom
/**
 * Le résumé d'une référence dans sa fiche dépliée.
 *
 * Jusqu'à L05-7, le parseur lisait `abstract` comme `notes` : le résumé
 * s'affichait sous « Note (BibTeX) ». Depuis, il vit dans `customFields`, que
 * la fiche ne lisait pas : il avait disparu de l'écran.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';

import { CitationCard } from '../CitationCard';
import type { Citation } from '../../../stores/bibliographyStore';

const ABSTRACT =
  "L'État moderne s'est construit par ses archives. Ce livre suit leur mise en ordre, de 1790 à 1914, et ce qu'elle a fait aux historiens.";

const citation = (over: Partial<Citation> = {}): Citation => ({
  id: 'dupont2010',
  type: 'book',
  author: 'Dupont',
  year: '2010',
  title: 'Les archives de l’État',
  ...over,
});

/** Affiche la fiche et la déplie, comme l'auteur : un clic sur son en-tête. */
async function expand(c: Citation): Promise<void> {
  render(<CitationCard citation={c} />);
  await act(async () => {
    fireEvent.click(screen.getByText('Dupont'));
  });
}

/** La ligne de détail qui porte ce libellé. */
function row(label: string): HTMLElement {
  const item = screen.getByText(label).closest('.detail-item');
  if (!(item instanceof HTMLElement)) throw new Error(`pas de ligne « ${label} »`);
  return item;
}

afterEach(() => {
  cleanup();
});

describe('CitationCard : le résumé', () => {
  it('un champ `abstract` s’affiche sous « Résumé »', async () => {
    await expand(citation({ customFields: { abstract: ABSTRACT } }));

    expect(within(row('bibliography.abstract')).getByText(ABSTRACT)).toBeTruthy();
  });

  it('la casse du nom de champ n’y fait rien : `Abstract`', async () => {
    await expand(citation({ customFields: { Abstract: ABSTRACT, url: 'https://example.org' } }));

    expect(within(row('bibliography.abstract')).getByText(ABSTRACT)).toBeTruthy();
  });

  it('un résumé qui contient du HTML s’affiche en texte, sans créer d’élément', async () => {
    const hostile = 'Avant <img src=x onerror="window.__abstractXss = 1"> après';

    await expand(citation({ customFields: { abstract: hostile } }));

    const line = row('bibliography.abstract');
    expect(within(line).getByText(hostile)).toBeTruthy();
    expect(line.querySelector('img')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('témoin : la note reste sous « Note (BibTeX) », et le résumé n’y vient pas', async () => {
    await expand(citation({ notes: 'Réimpr. 2015', customFields: { abstract: ABSTRACT } }));

    const note = row('bibliography.bibNote');
    expect(within(note).getByText('Réimpr. 2015')).toBeTruthy();
    expect(note.textContent).not.toContain(ABSTRACT);
  });

  it('témoin : sans résumé, pas de ligne « Résumé »', async () => {
    await expand(citation({ notes: 'Réimpr. 2015', customFields: { url: 'https://example.org' } }));

    expect(screen.queryByText('bibliography.abstract')).toBeNull();
    expect(screen.getByText('Réimpr. 2015')).toBeTruthy();
  });
});
