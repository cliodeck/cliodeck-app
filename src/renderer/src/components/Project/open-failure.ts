/**
 * Le message de chaque refus d'ouverture. « project.json est peut-être illisible ou endommagé » ne
 * vaut que pour un manifeste qui se lit mal : il couvrait tout, et l'auteur cherchait à réparer un
 * fichier intact quand un service n'avait pas démarré (BT1-5). Sans code connu, rien n'est supposé.
 */
export const OPEN_FAILURE_KEYS: Readonly<Record<string, string>> = {
  manifest_unreadable: 'project.openError',
  manifest_unwritable: 'project.openNotWritable',
  project_unavailable: 'project.openUnavailable',
  project_file_missing: 'project.openUnavailable',
  services_failed: 'project.servicesFailed',
};

/**
 * La clé du message d'un refus, ou undefined pour un code inconnu. `previousClosed` : le projet
 * ouvert avant n'a pas pu revenir, ou le main l'a fermé de lui-même ; « Rien n'a été modifié »
 * serait faux, et l'écran est passé à l'accueil (L03-3).
 */
export function openFailureKey(code: string | undefined, previousClosed = false): string | undefined {
  const key = code ? OPEN_FAILURE_KEYS[code] : undefined;
  return previousClosed && key === 'project.openUnavailable' ? 'project.openUnavailableClosed' : key;
}
