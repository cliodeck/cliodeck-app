/**
 * L'état de l'éditeur par document, hors de tout composant.
 *
 * Changer de mode démonte l'éditeur. Gardé dans le composant, ce cache disparaissait avec lui :
 * revenir en Écriture perdait le curseur et l'annulation, et une proposition tombait à l'offset 0.
 *
 * Il suit donc le projet par lui-même, éditeur monté ou non : les états mémorisés appartiennent au
 * manuscrit qu'on quitte, et un projet recréé au même chemin n'a pas à les retrouver.
 */
import { EditorStateCache } from '@/editor/cm/state-cache';
import { useProjectStore } from '../../stores/projectStore';

export const editorStates = new EditorStateCache();

/**
 * La clé d'un document : son chemin, ou pour un tampon sans titre son numéro de document, qui ne
 * bouge pas sur un changement de mode et change à tout remplacement. Un nouveau tampon ne reprend
 * donc jamais l'état d'un autre, même à texte identique.
 */
export function editorStateKey(filePath: string | null, documentVersion: number): string {
  return filePath ?? `untitled:${documentVersion}`;
}

export function resetEditorStates(): void {
  editorStates.clear();
}

let statesProject = useProjectStore.getState().currentProject?.path ?? null;
useProjectStore.subscribe((state) => {
  const project = state.currentProject?.path ?? null;
  if (project === statesProject) return;
  statesProject = project;
  resetEditorStates();
});
