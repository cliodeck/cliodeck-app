/**
 * Une opération lancée dans un projet ne finit pas dans le suivant.
 *
 * Après chaque attente, l'appelant se demande s'il est encore dans le projet où l'on a cliqué :
 * sinon il s'arrête, sans rien écrire ni montrer dans l'autre. Le main fait la même vérification
 * de son côté (`project-changed`), pour ce que le renderer enverrait quand même.
 */
import { useProjectStore } from '../stores/projectStore';

type ProjectStoreState = ReturnType<typeof useProjectStore.getState>;

/**
 * Encore dans le projet `path` ? Pendant l'ouverture d'un autre projet, le main l'a parfois déjà
 * pris (il initialise ses services) alors que l'écran montre encore `path` : on attend l'issue.
 * Une ouverture refusée laisse `path` ouvert, et la réponse est oui.
 */
export async function stillIn(path: string): Promise<boolean> {
  const leaving = (state: ProjectStoreState) => state.loadState.kind === 'loading' && state.loadState.path !== path;
  if (leaving(useProjectStore.getState())) {
    await new Promise<void>((resolve) => {
      const unsubscribe = useProjectStore.subscribe((state) => {
        if (leaving(state)) return;
        unsubscribe();
        resolve();
      });
    });
  }
  return useProjectStore.getState().currentProject?.path === path;
}

/** Le main a refusé la demande : le projet ouvert n'est plus celui pour lequel elle partait. */
export function refusedAsProjectChanged(response: { success?: boolean; error?: string } | null | undefined): boolean {
  return response?.success === false && response.error === 'project-changed';
}
