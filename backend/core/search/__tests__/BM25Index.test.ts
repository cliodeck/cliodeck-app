/**
 * BM25 des PDF (S01-1-0, L07-3).
 *
 * Avant L07-3, `BM25Index` passait une chaîne à `natural`, dont le tokeniseur
 * coupe un mot sur chaque lettre hors ASCII : « Liège » était indexé comme
 * « li » et « ge », alors que la requête gardait « liège ». Aucun mot accentué
 * n'était retrouvé, et les fragments répondaient à des requêtes qui ne les
 * visaient pas.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BM25Index, type BM25Result } from '../BM25Index.js';
import type { DocumentChunk } from '../../../types/pdf-document.js';

const chunk = (id: string, content: string): DocumentChunk => ({
  id,
  documentId: `doc-${id}`,
  content,
  pageNumber: 1,
  chunkIndex: 0,
  startPosition: 0,
  endPosition: content.length,
});

const indexOf = (...chunks: DocumentChunk[]): BM25Index => {
  const index = new BM25Index();
  index.addChunks(chunks);
  return index;
};

const ids = (results: BM25Result[]): string[] => results.map((r) => r.chunk.id);

const corpus = (): BM25Index =>
  indexOf(
    chunk('fr', "La Révolution française et la mémoire de l'État."),
    chunk('de', 'Zeitgeschichte und Ökonomie in Zürich.'),
    chunk('be', 'Le congrès de Liège réunit les délégués wallons.'),
    chunk('us', 'Le rôle des US et de la CIA en 1948.')
  );

beforeEach(() => {
  // `BM25Index` trace chaque construction et chaque mise à jour du cache.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('BM25Index', () => {
  it('trouve les mots accentués', () => {
    const index = corpus();
    expect(ids(index.search('révolution'))).toEqual(['fr']);
    expect(ids(index.search('Révolution française'))).toEqual(['fr']);
    expect(ids(index.search('Zürich'))).toEqual(['de']);
    expect(ids(index.search('Liège'))).toEqual(['be']);
    expect(ids(index.search('délégués'))).toEqual(['be']);
    expect(ids(index.search('État'))).toEqual(['fr']);
  });

  it('trouve un mot accentué tapé sans accent, et l’inverse', () => {
    const index = corpus();
    expect(ids(index.search('revolution'))).toEqual(['fr']);
    expect(ids(index.search('Liege'))).toEqual(['be']);
    expect(ids(index.search('Zurich'))).toEqual(['de']);
    expect(ids(index.search('ÉTAT'))).toEqual(['fr']);
  });

  it('les fragments d’un mot accentué ne répondent plus', () => {
    const index = corpus();
    expect(index.search('aise')).toEqual([]);
    expect(index.search('tat')).toEqual([]);
    expect(index.search('ge')).toEqual([]);
    expect(index.search('konomie')).toEqual([]);
  });

  it('une requête faite de mots vides ne rend rien, en français comme en anglais', () => {
    const index = corpus();
    expect(index.search('la de')).toEqual([]);
    expect(index.search('the of')).toEqual([]);
    expect(index.search('und in')).toEqual([]);
  });

  it('un sigle en capitales n’est pas un mot vide', () => {
    // « us » est un mot vide anglais ; « US » est un sigle.
    expect(ids(corpus().search('US'))).toEqual(['us']);
  });

  it('un mot qui ne diffère d’un mot vide que par l’accent reste cherchable', () => {
    // Les mots vides se reconnaissent accents compris : « mais » en est un, « maïs » non ; « wäre »
    // en est un, « Ware » (la marchandise) non. « hat » est aussi un nom anglais (the Hat Act).
    const index = indexOf(
      chunk('ware', 'Die Ware und ihr Tauschwert bei Marx.'),
      chunk('mais', 'La culture du maïs au Mexique.'),
      chunk('hat', 'The hat trade in eighteenth-century London.'),
      chunk('fur', 'The fur trade on the Great Lakes.')
    );
    expect(ids(index.search('Ware'))).toEqual(['ware']);
    expect(ids(index.search('maïs'))).toEqual(['mais']);
    expect(ids(index.search('hat'))).toEqual(['hat']);
    expect(ids(index.search('fur'))).toEqual(['fur']);
    // Sans son tréma, « mais » est la conjonction : un mot vide.
    expect(index.search('mais')).toEqual([]);
  });

  it('trouve un nom ou un terme qui s’écrit comme un mot-outil d’une autre langue', () => {
    // Les listes valent pour les trois langues à la fois. « seine », « oder », « weil », « allen »
    // (allemand), « durant », « celle » (français) en faisaient disparaître la Seine, l'Oder,
    // Patrick Weil, Allen Dulles, Will Durant et Celle : `main` les trouvait.
    const index = indexOf(
      chunk('seine', "Le préfet de la Seine signe l'arrêté de 1853."),
      chunk('oder', 'La ligne Oder-Neisse est reconnue par le traité de 1970.'),
      chunk('weil', 'Patrick Weil étudie la nationalité française.'),
      chunk('mir', 'Le mir russe redistribue les terres entre les familles.'),
      chunk('dulles', 'Allen Dulles dirige la CIA à partir de 1953.'),
      chunk('durant', 'William Durant fonde General Motors en 1908.'),
      chunk('sind', 'The conquest of Sind by Napier in 1843.'),
      chunk('celle', 'Le camp de Bergen-Belsen, au nord de Celle.'),
      chunk('notre-dame', "L'incendie de Notre-Dame de Paris."),
      chunk('das', 'Veena Das et l’anthropologie de la violence.'),
      chunk('ob', "Les rives de l'Ob en Sibérie."),
      chunk('wen', 'Wen Jiabao, Premier ministre chinois.')
    );
    expect(ids(index.search('Seine'))).toEqual(['seine']);
    expect(ids(index.search('la Seine'))).toEqual(['seine']);
    expect(ids(index.search('Oder'))).toEqual(['oder']);
    expect(ids(index.search('Weil'))).toEqual(['weil']);
    expect(ids(index.search('mir'))).toEqual(['mir']);
    expect(ids(index.search('Allen'))).toEqual(['dulles']);
    expect(ids(index.search('Durant'))).toEqual(['durant']);
    expect(ids(index.search('Sind'))).toEqual(['sind']);
    expect(ids(index.search('Celle'))).toEqual(['celle']);
    expect(ids(index.search('Notre-Dame'))).toEqual(['notre-dame']);
    expect(ids(index.search('Das'))).toEqual(['das']);
    expect(ids(index.search('Ob'))).toEqual(['ob']);
    expect(ids(index.search('Wen'))).toEqual(['wen']);
  });

  it('« constructor » n’empoisonne pas le score des autres termes', () => {
    // `doc['constructor']` lisait la fonction héritée d'Object : score NaN, et l'extrait disparaissait.
    const index = corpus();
    expect(ids(index.search('Zeitgeschichte constructor'))).toEqual(['de']);
    expect(index.search('constructor')).toEqual([]);
    const withWord = indexOf(chunk('pont', 'The constructor of the bridge'));
    expect(ids(withWord.search('constructor'))).toEqual(['pont']);
  });

  it('un terme répété dans la requête ne compte qu’une fois', () => {
    const index = corpus();
    const once = index.search('Zeitgeschichte');
    const twice = index.search('Zeitgeschichte Zeitgeschichte');
    expect(twice).toHaveLength(1);
    expect(twice[0].score).toBe(once[0].score);
  });

  it('la longueur d’un extrait est son nombre de mots, pas son nombre de mots distincts', () => {
    // Même fréquence de « Verdun » dans les deux : le plus court doit passer devant. Compter les
    // mots distincts (plus la clé `__key` de natural) faisait passer devant l'extrait qui répète.
    const index = indexOf(
      chunk('repete', `Verdun ${'bataille '.repeat(30)}`),
      chunk('court', 'Verdun Douaumont Vaux Argonne Meuse Somme Champagne Artois Flandres Marne Aisne')
    );
    expect(ids(index.search('Verdun'))).toEqual(['court', 'repete']);
  });

  it('les statistiques ne comptent pas la clé interne de natural', () => {
    const index = indexOf(chunk('a', 'Verdun Douaumont'), chunk('b', 'Verdun'));
    expect(index.getStats()).toEqual({ totalChunks: 2, vocabularySize: 2, averageDocLength: 1.5 });
  });

  it('se vide', () => {
    const index = corpus();
    index.clear();
    expect(index.getSize()).toBe(0);
    expect(index.search('Zeitgeschichte')).toEqual([]);
    index.addChunk(chunk('apres', 'Verdun'));
    expect(ids(index.search('Verdun'))).toEqual(['apres']);
    expect(index.getStats().averageDocLength).toBe(1);
  });
});
