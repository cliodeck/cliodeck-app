import { describe, it, expect } from 'vitest';
import {
  archivalFromTropyMetadata,
  formatArchivalCitation,
} from '../archival-metadata';

describe('archivalFromTropyMetadata', () => {
  it('maps Dublin Core-ish Tropy property bag to archival fields', () => {
    const raw = {
      title: 'Note de la Sûreté sur…',
      identifier: 'F/7/12345',
      isPartOf: 'Fonds Moscou (19940500)',
      publisher: 'Archives nationales (Pierrefitte-sur-Seine)',
      creator: "Ministère de l'Intérieur, Direction de la Sûreté",
      issued: '1939/1945',
      spatial: 'Paris',
      rights: 'Communicable after derogation',
      extent: '12 ff., 32x25cm',
    };
    const archival = archivalFromTropyMetadata(raw);
    expect(archival).toEqual({
      repository: 'Archives nationales (Pierrefitte-sur-Seine)',
      fonds: 'Fonds Moscou (19940500)',
      callNumber: 'F/7/12345',
      producer: "Ministère de l'Intérieur, Direction de la Sûreté",
      productionDate: '1939/1945',
      productionPlace: 'Paris',
      accessRestrictions: 'Communicable after derogation',
      physicalDescription: '12 ff., 32x25cm',
    });
  });

  it('falls back to TropyItem fields when DC terms are absent', () => {
    const archival = archivalFromTropyMetadata(
      {},
      { archive: 'BNF', collection: 'Manuscrits', creator: 'Anon.', date: '1789' }
    );
    expect(archival).toMatchObject({
      repository: 'BNF',
      fonds: 'Manuscrits',
      producer: 'Anon.',
      productionDate: '1789',
    });
  });

  it('returns undefined when nothing is known', () => {
    expect(archivalFromTropyMetadata({}, {})).toBeUndefined();
    expect(archivalFromTropyMetadata(undefined)).toBeUndefined();
  });

  it('ignores empty strings', () => {
    const archival = archivalFromTropyMetadata({ identifier: '   ', isPartOf: '' });
    expect(archival).toBeUndefined();
  });

  it('prefers explicit archival keys over generic DC fallbacks', () => {
    const archival = archivalFromTropyMetadata({
      callNumber: 'AN 72AJ/43',
      identifier: 'ignored-generic-id',
      producer: 'Explicit producer',
      creator: 'Generic creator',
    });
    expect(archival?.callNumber).toBe('AN 72AJ/43');
    expect(archival?.producer).toBe('Explicit producer');
  });
});

describe('formatArchivalCitation', () => {
  it('composes a historian-style citation string', () => {
    const citation = formatArchivalCitation({
      producer: "Ministère de l'Intérieur",
      productionDate: '1939/1945',
      callNumber: 'F/7/12345',
      fonds: 'Fonds Moscou',
      repository: 'Archives nationales',
    });
    expect(citation).toBe(
      "Ministère de l'Intérieur (1939/1945), F/7/12345, Fonds Moscou, Archives nationales"
    );
  });

  it('returns undefined for empty / missing input', () => {
    expect(formatArchivalCitation(undefined)).toBeUndefined();
    expect(formatArchivalCitation({})).toBeUndefined();
  });
});
