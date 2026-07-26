/**
 * Régression : `Cmd+Q` dans les secondes suivant une frappe perdait le
 * texte. `before-quit` arrêtait les services mais pas l'éditeur, et aucun
 * `beforeunload` n'existait côté renderer.
 *
 * On teste la DÉCISION (faut-il écrire ?) plutôt que le hook React, parce
 * que c'est là qu'est le piège : `isDirty` est mis à jour par une
 * synchronisation debouncée, donc il est encore faux au moment précis où
 * l'auteur risque de perdre son texte.
 */
import { describe, expect, it } from 'vitest';
import { needsFlush } from '../useSaveOnQuit';

describe('needsFlush', () => {
  it('écrit quand l’éditeur est marqué modifié', () => {
    expect(
      needsFlush({ filePath: '/p/document.md', isDirty: true, live: 'a', mirror: 'a' })
    ).toBe(true);
  });

  it('écrit quand le texte vivant a devancé le miroir du store', () => {
    // LE cas du bug : l'auteur vient de taper, la synchro debouncée n'a pas
    // encore couru, `isDirty` est donc encore faux.
    expect(
      needsFlush({
        filePath: '/p/document.md',
        isDirty: false,
        live: 'texte fraîchement tapé',
        mirror: 'texte',
      })
    ).toBe(true);
  });

  it('n’écrit pas quand rien n’a changé', () => {
    // Sinon on toucherait la date de tous les fichiers seulement ouverts.
    expect(
      needsFlush({ filePath: '/p/document.md', isDirty: false, live: 'a', mirror: 'a' })
    ).toBe(false);
  });

  it('n’écrit pas sans fichier de destination', () => {
    // Document jamais enregistré : il faudrait un « Enregistrer sous »,
    // qu'on ne peut pas demander pendant une fermeture.
    expect(needsFlush({ filePath: null, isDirty: true, live: 'a', mirror: '' })).toBe(false);
    expect(needsFlush({ filePath: '', isDirty: true, live: 'a', mirror: '' })).toBe(false);
  });
});
