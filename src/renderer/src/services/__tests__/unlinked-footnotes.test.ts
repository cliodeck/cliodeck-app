import { describe, it, expect, beforeAll } from 'vitest';
import i18next, { type TFunction } from 'i18next';
import fr from '../../../../../public/locales/fr/common.json';
import { unlinkedFootnotesNote } from '../unlinked-footnotes';

/** Les vraies chaînes françaises : c'est la phrase que l'auteur lira. */
let t: TFunction;
beforeAll(async () => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'fr',
    ns: ['common'],
    defaultNS: 'common',
    resources: { fr: { common: fr } },
    interpolation: { escapeValue: false },
  });
  t = instance.t.bind(instance);
});

describe('unlinkedFootnotesNote', () => {
  it('ne dit rien quand tout est lié', () => {
    expect(unlinkedFootnotesNote([{ title: 'Un', unlinked: [] }], t)).toBeNull();
  });

  it('livre : nomme chaque note et son chapitre, appels et définitions à part', () => {
    const note = unlinkedFootnotesNote(
      [
        { title: 'Un', unlinked: [] },
        {
          title: 'Deux',
          unlinked: [
            { kind: 'reference', label: '4' },
            { kind: 'definition', label: '7' },
            { kind: 'glued', label: '8' },
          ],
        },
        { title: 'Trois', unlinked: [{ kind: 'definition', label: '9' }] },
      ],
      t
    );

    expect(note).toBe(
      'Notes à vérifier. Appel sans définition : [^4] (« Deux »). ' +
        'Définitions sans appel : [^7] (« Deux »), [^9] (« Trois »). ' +
        'Définition collée au paragraphe qui la précède : [^8] (« Deux »). ' +
        "Sans ligne vide entre les deux, l'export l'imprime telle quelle. " +
        'Corrigez le texte, puis relancez la renumérotation.'
    );
  });

  it('article : le numéro seul, sans chapitre', () => {
    const note = unlinkedFootnotesNote([{ unlinked: [{ kind: 'definition', label: '3' }] }], t);

    expect(note).toBe(
      'Notes à vérifier. Définition sans appel : [^3]. Corrigez le texte, puis relancez la renumérotation.'
    );
  });

  it('une longue liste s’arrête, pour rester lisible', () => {
    const unlinked = Array.from({ length: 12 }, (_, i) => ({
      kind: 'definition' as const,
      label: String(i + 1),
    }));
    const note = unlinkedFootnotesNote([{ unlinked }], t) ?? '';

    expect(note).toContain('[^8], …');
    expect(note).not.toContain('[^9]');
  });
});
