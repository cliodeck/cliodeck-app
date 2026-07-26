/**
 * Attend que l'éditeur ait (re)créé sa façade après une bascule de fichier.
 *
 * `loadFile` installe le nouveau contenu dans le store, mais la vue
 * CodeMirror n'est reconstruite que par un `useEffect` de
 * `CodeMirrorEditor` — donc au commit React SUIVANT. Appeler
 * `editorFacade.revealLine()` juste après `await loadFile(...)` s'adressait
 * ainsi à la façade du chapitre SORTANT : la bascule avait bien lieu, mais
 * le curseur n'atteignait jamais le passage cherché.
 *
 * Le commentaire du code affirmait pourtant « après `loadFile` la façade est
 * reconstruite » — c'est cette croyance qui rendait le défaut invisible.
 */
import { useEditorStore } from '../stores/editorStore';
import type { EditorFacade } from '@/editor/facade';

/**
 * Résout dès qu'une façade DIFFÉRENTE de `previous` est disponible.
 *
 * Borné dans le temps : si l'éditeur ne se remonte pas (fichier illisible,
 * panneau démonté), mieux vaut rendre la main que suspendre l'appelant. On
 * renvoie alors ce que porte le store, quitte à ce que ce soit `null` —
 * l'appelant décide.
 */
export function waitForEditorFacade(
  previous: EditorFacade | null,
  timeoutMs = 2000
): Promise<EditorFacade | null> {
  const current = useEditorStore.getState().editorFacade;
  if (current && current !== previous) return Promise.resolve(current);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (facade: EditorFacade | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(facade);
    };

    const timer = setTimeout(
      () => finish(useEditorStore.getState().editorFacade),
      timeoutMs
    );

    const unsubscribe = useEditorStore.subscribe((state) => {
      if (state.editorFacade && state.editorFacade !== previous) {
        finish(state.editorFacade);
      }
    });
  });
}
