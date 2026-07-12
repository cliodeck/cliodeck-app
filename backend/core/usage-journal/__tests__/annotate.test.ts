import { describe, expect, it } from 'vitest';
import { localDateKey, parseSessionSelection, parseVerdict } from '../annotate.js';

describe('parseVerdict', () => {
  it('mappe les initiales et noms complets', () => {
    expect(parseVerdict('w')).toBe('worth_it');
    expect(parseVerdict('o')).toBe('worth_it');
    expect(parseVerdict('n')).toBe('not_worth_it');
    expect(parseVerdict('u')).toBe('unsure');
    expect(parseVerdict('?')).toBe('unsure');
    expect(parseVerdict('p')).toBe('pending');
    expect(parseVerdict('worth_it')).toBe('worth_it');
    expect(parseVerdict('NOT_WORTH_IT')).toBe('not_worth_it');
  });
  it('vide → pending, inconnu → null', () => {
    expect(parseVerdict('')).toBe('pending');
    expect(parseVerdict('   ')).toBe('pending');
    expect(parseVerdict('xyz')).toBeNull();
  });
});

describe('parseSessionSelection', () => {
  it('all / tout / * → toutes', () => {
    expect(parseSessionSelection('all', 3)).toEqual([0, 1, 2]);
    expect(parseSessionSelection('tout', 2)).toEqual([0, 1]);
    expect(parseSessionSelection('*', 1)).toEqual([0]);
  });
  it('listes, plages, espaces ; dédup et tri', () => {
    expect(parseSessionSelection('1,3', 3)).toEqual([0, 2]);
    expect(parseSessionSelection('3 1 1', 3)).toEqual([0, 2]);
    expect(parseSessionSelection('1-3', 4)).toEqual([0, 1, 2]);
    expect(parseSessionSelection('2-1', 4)).toEqual([0, 1]); // plage inversée
  });
  it('vide → aucune ; hors bornes / non numérique ignorés', () => {
    expect(parseSessionSelection('', 3)).toEqual([]);
    expect(parseSessionSelection('0,5,abc,2', 3)).toEqual([1]); // seul 2 est valide
  });
});

describe('localDateKey', () => {
  it('formate YYYY-MM-DD en heure locale', () => {
    expect(localDateKey(new Date(2026, 6, 5, 23, 59))).toBe('2026-07-05');
    expect(localDateKey(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });
});
