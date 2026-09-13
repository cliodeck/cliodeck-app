import { describe, it, expect } from 'vitest';
import type { ZoteroItem } from '../../../integrations/zotero/ZoteroAPI';
import { findDuplicateWorks, normalizeDOI, normalizeTitle } from '../duplicates';

function item(
  key: string,
  title: string,
  date?: string,
  DOI?: string,
  lastName?: string
): ZoteroItem {
  return {
    key,
    version: 0,
    library: { type: 'user', id: 1, name: '' },
    data: {
      key,
      version: 0,
      itemType: 'journalArticle',
      title,
      date,
      DOI,
      creators: lastName ? [{ creatorType: 'author', lastName, firstName: 'X' }] : undefined,
    },
  } as ZoteroItem;
}

describe('normalisation', () => {
  it('confond les ligatures avec leur écriture développée', () => {
    // Une copie du même article portait « In℡ligent » : c'est U+2121,
    // que NFKD ramène à « TEL ».
    expect(normalizeTitle('Rendered Artificially In℡ligent?')).toBe(
      normalizeTitle('Rendered artificially intelligent')
    );
  });

  it('confond apostrophes droites et typographiques, et la ponctuation', () => {
    expect(normalizeTitle("Russia's War: Humans and Machines")).toBe(
      normalizeTitle('Russia’s war — humans and machines')
    );
  });

  it('ramène un DOI à sa forme nue', () => {
    expect(normalizeDOI('https://doi.org/10.1111/HITH.12278')).toBe('10.1111/hith.12278');
    expect(normalizeDOI('doi: 10.1111/hith.12278')).toBe('10.1111/hith.12278');
  });
});

describe('findDuplicateWorks', () => {
  it('ne signale rien sur une collection saine', () => {
    expect(
      findDuplicateWorks([
        item('A', 'Mapping the Latent Past', '2024'),
        item('B', 'Artificial Historians', '2026'),
      ])
    ).toEqual([]);
  });

  it('rapproche deux notices par leur DOI, même titre différent', () => {
    const found = findDuplicateWorks([
      item('A', 'Digital Doping for Historians', '2022', '10.1111/hith.12278'),
      item('B', 'Digital doping (tiré à part)', '2022', 'https://doi.org/10.1111/HITH.12278'),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe('doi');
    expect(found[0].keys).toEqual(['A', 'B']);
  });

  it('rapproche deux saisies du même article par titre et année', () => {
    const found = findDuplicateWorks([
      item('LB9BWA67', 'Mapping the Latent Past: Assessing Large Language Models', '2024'),
      item('YJGVBUVR', 'Mapping the latent past: assessing large language models', '2024'),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe('title-year');
    expect(found[0].keys).toEqual(['LB9BWA67', 'YJGVBUVR']);
  });

  it('rapproche une notice sans date de son homologue daté', () => {
    // Cas réel : la même contribution saisie comme chapitre (2025) et
    // comme article sans date.
    const found = findDuplicateWorks([
      item('SRWBQPK2', "4 AI visions: Representing Russia's War Against Ukraine", '2025'),
      item('NMDMR95J', "4 AI visions: Representing Russia's War Against Ukraine"),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].keys).toEqual(['SRWBQPK2', 'NMDMR95J']);
  });

  it('ne rapproche pas deux éditions d’années différentes', () => {
    expect(
      findDuplicateWorks([
        item('A', 'The Allure of the Archives', '1989'),
        item('B', 'The Allure of the Archives', '2013'),
      ])
    ).toEqual([]);
  });

  it('ne rapproche pas deux titres courts et génériques', () => {
    expect(
      findDuplicateWorks([
        item('A', 'Introduction', '2022'),
        item('B', 'Introduction', '2022'),
      ])
    ).toEqual([]);
  });

  it('ne rapproche pas deux textes homonymes de plumes différentes', () => {
    expect(
      findDuplicateWorks([
        item('A', 'Artificial Intelligence and History', '2024', undefined, 'Dupont'),
        item('B', 'Artificial Intelligence and History', '2024', undefined, 'Martin'),
      ])
    ).toEqual([]);
  });

  it('rapproche un titre long dont une notice a perdu son auteur', () => {
    const found = findDuplicateWorks([
      item('A', 'Assessing Large Language Models as Digital Tools', '2024', undefined, 'Hutchinson'),
      item('B', 'Assessing Large Language Models as Digital Tools', '2024'),
    ]);
    expect(found).toHaveLength(1);
  });

  it('réunit en un seul groupe une œuvre saisie trois fois', () => {
    const found = findDuplicateWorks([
      item('A', 'Mapping the Latent Past', '2024', '10.1000/xyz'),
      item('B', 'Mapping the latent past', '2024'),
      item('C', 'Autre chose', '2024', '10.1000/XYZ'),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].keys).toEqual(['A', 'B', 'C']);
    expect(found[0].reason).toBe('doi');
  });

  it('rend le titre lisible du premier membre', () => {
    const found = findDuplicateWorks([
      item('A', 'Mapping the Latent Past', '2024'),
      item('B', 'mapping the latent past', '2024'),
    ]);
    expect(found[0].title).toBe('Mapping the Latent Past');
  });
});
