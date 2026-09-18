import { describe, it, expect } from 'vitest';
import { LOW_TEXT_CHARS_PER_PAGE, measureTextDensity } from '../text-density';

describe('measureTextDensity (#132)', () => {
  it('un PDF image (aucun texte) est signalé', () => {
    expect(measureTextDensity(Array.from({ length: 13 }, () => ({ text: '' })))).toEqual({ charsPerPage: 0, lowText: true });
  });

  it('un scan dont seul l’en-tête de l’éditeur est du texte est signalé', () => {
    const header = 'http://abs.sagepub.com Downloaded from abs.sagepub.com at University 2007';
    const d = measureTextDensity(Array.from({ length: 16 }, () => ({ text: header })));
    expect(d.lowText).toBe(true);
  });

  it('une page de texte courante ne l’est pas, ni une diapositive sobre', () => {
    const page = 'Les historiens étudient les sources primaires et secondaires. '.repeat(30);
    expect(measureTextDensity([{ text: page }]).lowText).toBe(false);
    const slide = 'Méthodes numériques en histoire : corpus, lecture distante, apprentissage automatique et critique des sources';
    expect(measureTextDensity([{ text: slide }]).charsPerPage).toBeGreaterThanOrEqual(LOW_TEXT_CHARS_PER_PAGE - 10);
  });

  it('les espaces ne comptent pas : une page aérée de trois mots reste sans texte', () => {
    expect(measureTextDensity([{ text: `${' '.repeat(5000)}Page trois mots` }]).lowText).toBe(true);
  });

  it('aucun page extraite = sans texte', () => {
    expect(measureTextDensity([])).toEqual({ charsPerPage: 0, lowText: true });
  });
});
