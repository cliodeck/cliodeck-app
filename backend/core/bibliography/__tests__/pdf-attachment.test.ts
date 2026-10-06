import { describe, it, expect } from 'vitest';
import { isPdfPath } from '../pdf-attachment';

describe('isPdfPath', () => {
  it('reconnaît un PDF quelle que soit la casse de l’extension', () => {
    expect(isPdfPath('/projet/PDFs/Fickers_-_2020.pdf')).toBe(true);
    expect(isPdfPath('/projet/PDFs/prclaudelevistraussesprit63.PDF')).toBe(true);
  });

  it('écarte un instantané de page web rapatrié de Zotero', () => {
    expect(isPdfPath('/projet/PDFs/13082.html')).toBe(false);
    expect(isPdfPath('/projet/PDFs/rapport.pdf.html')).toBe(false);
  });

  it('écarte une notice sans fichier', () => {
    expect(isPdfPath(undefined)).toBe(false);
    expect(isPdfPath(null)).toBe(false);
    expect(isPdfPath('')).toBe(false);
  });
});
