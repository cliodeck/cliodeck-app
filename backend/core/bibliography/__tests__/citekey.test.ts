import { describe, it, expect } from 'vitest';
import type { ZoteroItem } from '../../../integrations/zotero/ZoteroAPI';
import { assignCiteKeys, baseCiteKey, uniqueCiteKey, asciiFold } from '../citekey';

type Creator = { creatorType: string; firstName?: string; lastName?: string; name?: string };

function item(
  key: string,
  data: {
    creators?: Creator[];
    date?: string;
    title?: string;
    itemType?: string;
    dateAdded?: string;
  } = {}
): ZoteroItem {
  return {
    key,
    version: 0,
    library: { type: 'user', id: 1, name: '' },
    data: {
      key,
      version: 0,
      itemType: data.itemType ?? 'journalArticle',
      title: data.title,
      creators: data.creators,
      date: data.date,
      dateAdded: data.dateAdded,
    },
  } as ZoteroItem;
}

const author = (lastName: string, firstName = 'X'): Creator => ({
  creatorType: 'author',
  lastName,
  firstName,
});

/** Alphabet accepté par pandoc dans une clé de citation. */
const SAFE_KEY = /^[A-Za-z0-9_:-]+$/;

describe('baseCiteKey — alphabet', () => {
  it('ramène les tirets typographiques au tiret ASCII', () => {
    // U+2010 recopié depuis Zotero : pandoc refusait le fichier entier
    // (« unexpected \8208 »), donc plus aucune citation ne se résolvait.
    const key = baseCiteKey(item('A', { creators: [author('Hughes‐Warrington')], date: '2025' }));
    expect(key).toBe('Hughes-Warrington_2025');
    expect(key).toMatch(SAFE_KEY);
  });

  it('translittère les diacritiques', () => {
    expect(baseCiteKey(item('A', { creators: [author('Hernández')], date: '2025' })))
      .toBe('Hernandez_2025');
    expect(baseCiteKey(item('B', { creators: [author('Bareikytė')], date: '2025' })))
      .toBe('Bareikyte_2025');
  });

  it('supprime parenthèses et apostrophes', () => {
    // « Certeau(de)_2010 » : pandoc tronquait la clé à la parenthèse.
    expect(baseCiteKey(item('A', { creators: [author('Certeau (de)')], date: '2010' })))
      .toBe('Certeau_2010');
    expect(baseCiteKey(item('B', { creators: [author('O’Brien')], date: '2020' })))
      .toBe('OBrien_2020');
  });

  it('conserve un patronyme en plusieurs mots', () => {
    expect(baseCiteKey(item('A', { creators: [author('Van Der Werf')], date: '2022' })))
      .toBe('VanDerWerf_2022');
  });

  it('produit toujours une clé sûre, même sur un nom entièrement non latin', () => {
    const key = baseCiteKey(item('A', { creators: [author('日本語')], title: 'Sources', date: '2020' }));
    expect(key).toMatch(SAFE_KEY);
  });
});

describe('baseCiteKey — repli du libellé', () => {
  it('utilise l’éditeur scientifique quand il n’y a pas d’auteur', () => {
    // Un ouvrage dirigé n'a que des `editor` : trois de ces livres
    // partageaient la clé `Unknown_2022` dans une bibliographie réelle.
    const key = baseCiteKey(
      item('A', {
        itemType: 'book',
        creators: [{ creatorType: 'editor', lastName: 'Jaillant', firstName: 'Lise' }],
        date: '2022',
      })
    );
    expect(key).toBe('Jaillant_2022');
  });

  it('utilise le programmeur d’un logiciel', () => {
    const key = baseCiteKey(
      item('A', {
        itemType: 'computerProgram',
        creators: [{ creatorType: 'programmer', name: 'Digital History Lab' }],
        date: '2022',
      })
    );
    expect(key).toBe('Lab_2022');
  });

  it('retombe sur le premier mot significatif du titre sans créateur', () => {
    expect(
      baseCiteKey(item('A', { title: 'Archives, Access and Artificial Intelligence', date: '2022' }))
    ).toBe('Archives_2022');
  });

  it('retombe sur Anon quand il n’y a ni créateur ni titre', () => {
    expect(baseCiteKey(item('A', {}))).toBe('Anon_nd');
  });

  it('marque l’absence de date plutôt que de laisser un tiret bas orphelin', () => {
    expect(baseCiteKey(item('A', { creators: [author('Makhortykh')] }))).toBe('Makhortykh_nd');
  });
});

describe('uniqueCiteKey', () => {
  it('laisse la clé nue à la première occurrence puis suffixe', () => {
    const taken = new Set<string>();
    expect(uniqueCiteKey('Dupont_2024', taken)).toBe('Dupont_2024');
    expect(uniqueCiteKey('Dupont_2024', taken)).toBe('Dupont_2024a');
    expect(uniqueCiteKey('Dupont_2024', taken)).toBe('Dupont_2024b');
  });

  it('passe à deux lettres au-delà de z', () => {
    const taken = new Set<string>(['K_2024']);
    const keys = Array.from({ length: 27 }, () => uniqueCiteKey('K_2024', taken));
    expect(keys[25]).toBe('K_2024z');
    expect(keys[26]).toBe('K_2024aa');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('respecte les clés déjà réservées', () => {
    const taken = new Set(['Dupont_2024']);
    expect(uniqueCiteKey('Dupont_2024', taken)).toBe('Dupont_2024a');
  });
});

describe('assignCiteKeys', () => {
  it('désambiguïse deux œuvres homonymes', () => {
    // Cas mesuré : deux articles Hutchinson 2024 (deux items Zotero
    // distincts) écrivaient deux entrées `@article{Hutchinson_2024}` —
    // pandoc n'en garde qu'une, silencieusement.
    const items = [
      item('LB9BWA67', { creators: [author('Hutchinson')], date: '2024', dateAdded: '2024-01-01' }),
      item('YJGVBUVR', { creators: [author('Hutchinson')], date: '2024', dateAdded: '2025-06-01' }),
    ];
    const keys = assignCiteKeys(items);
    expect(keys.get('LB9BWA67')).toBe('Hutchinson_2024');
    expect(keys.get('YJGVBUVR')).toBe('Hutchinson_2024a');
  });

  it('ne renomme pas les clés existantes quand un homonyme arrive plus tard', () => {
    const first = item('AAA', { creators: [author('Hutchinson')], date: '2024', dateAdded: '2024-01-01' });
    const later = item('BBB', { creators: [author('Hutchinson')], date: '2024', dateAdded: '2025-06-01' });

    const before = assignCiteKeys([first]);
    const after = assignCiteKeys([later, first]); // ordre d'arrivée indifférent

    expect(after.get('AAA')).toBe(before.get('AAA'));
    expect(after.get('BBB')).not.toBe(after.get('AAA'));
  });

  it('sépare trois œuvres qui tombaient toutes dans Unknown_2022', () => {
    const items = [
      item('YQ73A8EF', {
        itemType: 'computerProgram',
        creators: [{ creatorType: 'programmer', name: 'Kansteiner Wulf' }],
        title: "What Do AIs 'Know' About History?",
        date: '2022',
        dateAdded: '2022-01-01',
      }),
      item('IWLK9XMW', {
        itemType: 'book',
        creators: [{ creatorType: 'editor', lastName: 'Jaillant', firstName: 'Lise' }],
        title: 'Archives, Access and Artificial Intelligence',
        date: '2022',
        dateAdded: '2022-02-01',
      }),
      item('LB4ZZMT9', {
        itemType: 'book',
        creators: [{ creatorType: 'editor', lastName: 'Fickers', firstName: 'Andreas' }],
        title: 'Digital History and Hermeneutics',
        date: '2022',
        dateAdded: '2022-03-01',
      }),
    ];
    const keys = [...assignCiteKeys(items).values()];
    expect(new Set(keys).size).toBe(3);
    expect(keys).not.toContain('Unknown_2022');
  });

  it('réserve les clés déjà prises localement', () => {
    const taken = new Set(['Hutchinson_2024']);
    const keys = assignCiteKeys(
      [item('BBB', { creators: [author('Hutchinson')], date: '2024' })],
      taken
    );
    expect(keys.get('BBB')).toBe('Hutchinson_2024a');
  });

  it('reconduit une clé déjà écrite dans le manuscrit', () => {
    // `[@Fickers_2022]` désignait le chapitre. Le livre du même directeur
    // entre dans la collection : c'est lui qui prend le suffixe, pas le
    // chapitre déjà cité — même s'il a été ajouté à Zotero bien avant.
    const chapitre = item('CHAP', {
      itemType: 'bookSection',
      creators: [author('Fickers')],
      date: '2022',
      dateAdded: '2026-09-11',
    });
    const livre = item('LIVRE', {
      itemType: 'book',
      creators: [{ creatorType: 'editor', lastName: 'Fickers', firstName: 'Andreas' }],
      date: '2022',
      dateAdded: '2022-01-01',
    });

    const keys = assignCiteKeys([chapitre, livre], new Set(), { CHAP: 'Fickers_2022' });

    expect(keys.get('CHAP')).toBe('Fickers_2022');
    expect(keys.get('LIVRE')).toBe('Fickers_2022a');
  });

  it('ne reconduit pas une clé que pandoc refuse', () => {
    const keys = assignCiteKeys(
      [item('A', { creators: [author('Certeau (de)')], date: '2010' })],
      new Set(),
      { A: 'Certeau(de)_2010' }
    );
    expect(keys.get('A')).toBe('Certeau_2010');
  });

  it('ne reconduit pas l’ancien repli Unknown_', () => {
    const keys = assignCiteKeys(
      [
        item('A', {
          itemType: 'book',
          creators: [{ creatorType: 'editor', lastName: 'Jaillant', firstName: 'Lise' }],
          date: '2022',
        }),
      ],
      new Set(),
      { A: 'Unknown_2022' }
    );
    expect(keys.get('A')).toBe('Jaillant_2022');
  });

  it('produit des clés uniques et lisibles par pandoc sur un lot hétérogène', () => {
    const items = [
      item('1', { creators: [author('Hughes‐Warrington')], date: '2026' }),
      item('2', { creators: [author('Hughes‐Warrington')], date: '2026' }),
      item('3', { creators: [author('Certeau (de)')], date: '2010' }),
      item('4', { title: 'Un instant…' }),
      item('5', {}),
      item('6', { creators: [author('Hernández')], date: '2025' }),
    ];
    const keys = [...assignCiteKeys(items).values()];
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(6);
    for (const key of keys) expect(key).toMatch(SAFE_KEY);
  });
});

describe('asciiFold', () => {
  it('ne renvoie rien plutôt qu’un caractère interdit', () => {
    expect(asciiFold('«»')).toBe('');
  });
});
