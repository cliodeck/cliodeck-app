/**
 * Normalisation du texte commune aux recherches lexicales (L07-3).
 *
 * `tokenize` est partagé par l'index et par la requête : tout ce qui sépare
 * deux graphies d'un même mot (NFC et NFD, casse, accents) doit donner le même
 * jeton des deux côtés, sinon le mot n'est jamais retrouvé.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_STOPWORDS,
  STOPWORDS,
  containsWord,
  foldCase,
  foldDiacritics,
  toNfc,
  tokenize,
} from '../normalize.js';

describe('tokenize', () => {
  it('donne le même jeton pour un mot en NFC et en NFD', () => {
    const nfc = 'Liège';
    const nfd = 'Liège';
    expect(nfc).not.toBe(nfd);
    expect(tokenize(nfd)).toEqual(tokenize(nfc));
    expect(tokenize(nfd)).toEqual(['Liège']);
    expect(tokenize(nfd, { fold: 'case' })).toEqual(['liège']);
    expect(tokenize(nfd, { fold: 'diacritics' })).toEqual(['liege']);
  });

  it('ne coupe pas un mot sur une lettre accentuée ni sur ß', () => {
    // Le défaut de `natural` : « Révolution » devenait « r » et « volution ».
    expect(tokenize("La Révolution française et l'État", { fold: 'case' })).toEqual([
      'la',
      'révolution',
      'française',
      'et',
      'l',
      'état',
    ]);
    expect(tokenize('Größe', { fold: 'case' })).toEqual(['größe']);
    expect(tokenize('Größe', { fold: 'diacritics' })).toEqual(['große']);
    expect(tokenize('Zürich, Österreich', { fold: 'diacritics' })).toEqual([
      'zurich',
      'osterreich',
    ]);
  });

  it('garde les capitales sans repli, et un mot en capitales n’est jamais un mot vide', () => {
    expect(tokenize('Rôle de la CIA')).toEqual(['Rôle', 'de', 'la', 'CIA']);
    // « us », « sa », « ce » sont des mots vides ; « US », « SA », « CE » sont des sigles.
    expect(
      tokenize('Rôle des US et de la CIA en 1948', { fold: 'diacritics', stopwords: true })
    ).toEqual(['role', 'us', 'cia', '1948']);
    expect(tokenize('la SA et sa doctrine', { fold: 'diacritics', stopwords: true })).toEqual([
      'sa',
      'doctrine',
    ]);
    // Une seule lettre n'est pas un sigle : « A » et « I » restent des mots vides.
    expect(tokenize('A war I remember', { fold: 'case', stopwords: true })).toEqual([
      'war',
      'remember',
    ]);
  });

  it('écarte les mots vides français, anglais et allemands, accentués ou non', () => {
    expect(tokenize('la de the of und der', { stopwords: true })).toEqual([]);
    expect(tokenize("Qu'il a été dit à l'époque", { fold: 'case', stopwords: true })).toEqual([
      'été',
      'époque',
    ]);
    expect(tokenize('Er sagte, dass es über die Grenze ging', { stopwords: true })).toEqual([
      'sagte',
      'Grenze',
      'ging',
    ]);
  });

  it('garde les termes d’historien qu’une liste usuelle écarterait', () => {
    const kept = tokenize(
      "l'État, l'Église, le Front, le Parti, l'Est, l'été 1914, les étés, les sommes, l'Avant, la Contre-Réforme, the Cold War, May 1968, the general will, a nun, the common man, the Hat Act, die Waren, die Ware, the fur trade, le maïs",
      { fold: 'diacritics', stopwords: true }
    );
    for (const term of [
      'etat',
      'eglise',
      'front',
      'parti',
      'est',
      'ete',
      'etes',
      'sommes',
      'avant',
      'contre',
      'war',
      'may',
      'will',
      'nun',
      'man',
      'hat',
      'waren',
      'ware',
      'fur',
      'mais',
    ]) {
      expect(kept).toContain(term);
    }
  });

  it('reconnaît un mot vide accents compris, avant le repli', () => {
    // Replié d'abord, « maïs » devenait « mais », « Ware » le « wäre » replié, « étés » « êtes ».
    expect(
      tokenize('mais maïs wäre Ware für fur über êtes étés', { fold: 'diacritics', stopwords: true })
    ).toEqual(['mais', 'ware', 'fur', 'etes']);
    // Un mot vide accentué tapé sans accent reste un mot vide quand cette graphie n'est pas un mot.
    expect(tokenize('etre etait etaient apres', { stopwords: true })).toEqual([]);
  });

  it('écarte les mots-outils des questions, en français, en anglais et en allemand', () => {
    expect(
      tokenize(
        'Comment, pourquoi, quand, pendant, depuis, entre, après, comme, selon, quels étaient',
        { stopwords: true }
      )
    ).toEqual([]);
    expect(
      tokenize('About, after, before, between, during, there, other, while, since, through, because', {
        stopwords: true,
      })
    ).toEqual([]);
    expect(tokenize('Zwischen, während, warum, wann, nachdem, obwohl', { stopwords: true })).toEqual(
      []
    );
  });

  it('découpe le chinois et le japonais en bigrammes', () => {
    expect(tokenize('東京大学')).toEqual(['東京', '京大', '大学']);
    expect(tokenize('カタカナ')).toEqual(['カタ', 'タカ', 'カナ']);
    expect(tokenize('京')).toEqual(['京']);
    // Une suite mêlée se sépare d'abord par écriture.
    expect(tokenize('東京Tokyo', { fold: 'case' })).toEqual(['東京', 'tokyo']);
  });

  it('applique la longueur minimale après repli', () => {
    expect(tokenize('a bc déf', { minLength: 2 })).toEqual(['bc', 'déf']);
  });
});

describe('replis', () => {
  it('toNfc, foldCase, foldDiacritics', () => {
    expect(toNfc('Liège')).toBe('Liège');
    expect(foldCase('Liège')).toBe('liège');
    expect(foldDiacritics('Liège')).toBe('liege');
    expect(foldDiacritics('ÉTAT')).toBe('etat');
    expect(foldDiacritics('Größe')).toBe('große');
  });
});

describe('containsWord', () => {
  it('ne trouve qu’un mot entier, pas une sous-chaîne', () => {
    expect(containsWord('Le rôle de la CIA en 1954', 'CIA')).toBe(true);
    expect(containsWord("La CIA's station", 'CIA')).toBe(true);
    expect(containsWord('(CIA)', 'CIA')).toBe(true);
    expect(containsWord('négociations sociales', 'cia')).toBe(false);
    expect(containsWord('SOCIAL', 'CIA')).toBe(false);
    expect(containsWord('refusa', 'usa')).toBe(false);
  });

  it('une lettre accentuée ou un chiffre voisin fait partie du mot', () => {
    expect(containsWord('Liège', 'Li')).toBe(false);
    expect(containsWord('éCIA', 'CIA')).toBe(false);
    expect(containsWord('CIA2', 'CIA')).toBe(false);
    expect(containsWord('écia', 'cia')).toBe(false);
  });

  it('trouve une occurrence entière après une occurrence collée', () => {
    expect(containsWord('sociale puis CIA', 'CIA')).toBe(true);
    expect(containsWord('sociales et cia', 'cia')).toBe(true);
    expect(containsWord('', 'cia')).toBe(false);
    expect(containsWord('cia', '')).toBe(false);
  });
});

describe('listes de mots vides', () => {
  it('sont écrites en minuscules, accents compris, et l’union les contient toutes', () => {
    for (const lang of ['fr', 'en', 'de'] as const) {
      for (const word of STOPWORDS[lang]) {
        expect(foldCase(word)).toBe(word);
        expect(ALL_STOPWORDS.has(word)).toBe(true);
      }
    }
  });
});
