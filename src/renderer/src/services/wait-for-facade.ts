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
import { useWorkspaceModeStore } from '../stores/workspaceModeStore';
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

/**
 * Rend la façade de la vue qui montre le document `documentVersion` dès qu'elle est montée, ou
 * `null` dès qu'un autre document a pris sa place.
 *
 * Sans délai, contrairement à `waitForEditorFacade` : hors du mode Écriture, l'éditeur peut ne se
 * remonter que bien plus tard, et c'est cette vue-là qu'on attend. Un remplacement de document
 * retire la façade du store en même temps qu'il change ce numéro (`replaceBuffer`) : une façade
 * présente sous ce numéro appartient donc à une vue créée pour lui.
 */
export function waitForDocumentFacade(documentVersion: number): Promise<EditorFacade | null> {
  type State = ReturnType<typeof useEditorStore.getState>;
  // `undefined` : rien de tranché, on attend encore.
  const settle = (state: State): EditorFacade | null | undefined =>
    state.documentVersion !== documentVersion ? null : (state.editorFacade ?? undefined);

  const now = settle(useEditorStore.getState());
  if (now !== undefined) return Promise.resolve(now);
  return new Promise((resolve) => {
    const unsubscribe = useEditorStore.subscribe((state) => {
      const outcome = settle(state);
      if (outcome === undefined) return;
      unsubscribe();
      resolve(outcome);
    });
  });
}

/**
 * Passe en Écriture et rend la façade de l'éditeur qui s'y trouve, `null` s'il ne monte pas.
 *
 * L'éditeur n'est monté qu'en mode Écriture. Hors de ce mode, une façade encore là appartient à
 * une vue qui part : c'est la suivante qu'on attend. Déjà en Écriture, on ne bascule rien et on
 * n'attend que si un document est en train d'en remplacer un autre.
 */
export function ensureWriteEditor(timeoutMs?: number): Promise<EditorFacade | null> {
  const workspace = useWorkspaceModeStore.getState();
  const { editorFacade } = useEditorStore.getState();
  if (workspace.active === 'write') {
    return editorFacade ? Promise.resolve(editorFacade) : waitForEditorFacade(null, timeoutMs);
  }
  workspace.setActive('write');
  return waitForEditorFacade(editorFacade, timeoutMs);
}
