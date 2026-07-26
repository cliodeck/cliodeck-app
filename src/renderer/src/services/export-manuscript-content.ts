/**
 * Contenu à exporter pour un projet à fichier unique (article, présentation).
 *
 * Le tampon de l'éditeur ne contient que le fichier **ouvert** — or le panneau
 * projet invite explicitement à ouvrir `abstract.md` ou `context.md`. Exporter
 * ce tampon sans vérifier produisait un PDF contenant le résumé sous le titre
 * de l'article, sans le moindre avertissement.
 *
 * Règle appliquée ici, symétrique de celle du livre : si le fichier ouvert est
 * bien le manuscrit, le contenu vient de l'**éditeur vivant** (les frappes non
 * sauvegardées comptent) ; sinon il est lu sur le disque. Les présentations
 * relisaient `slides.md` sur le disque même quand il était ouvert et modifié —
 * elles perdaient donc tout ce qui n'avait pas encore été sauvegardé.
 *
 * Le livre ne passe pas par ici : il n'a pas de document unique, son manuscrit
 * est assemblé côté main à partir du manifeste.
 */
/** Nom du fichier manuscrit, par type de projet à fichier unique. */
export function manuscriptFileName(projectType: string): string {
  return projectType === 'presentation' ? 'slides.md' : 'document.md';
}

export type ManuscriptContent =
  | { ok: true; content: string; fromEditor: boolean }
  | { ok: false; missingFile: string };

/**
 * Résout le texte à exporter.
 *
 * @param projectPath Racine du projet.
 * @param projectType `article` | `presentation` (le livre n'appelle pas ceci).
 * @param openFilePath Chemin absolu du fichier ouvert dans l'éditeur, s'il y en a un.
 * @param getLiveContent Texte vivant de l'éditeur (façade CM6).
 * @param readFile Lecture disque, injectable pour les tests.
 */
export async function resolveManuscriptContent(
  projectPath: string,
  projectType: string,
  openFilePath: string | null | undefined,
  getLiveContent: () => string,
  readFile: (path: string) => Promise<string> = (p) =>
    window.electron.fs.readFile(p)
): Promise<ManuscriptContent> {
  const fileName = manuscriptFileName(projectType);
  const manuscriptPath = `${projectPath}/${fileName}`;

  if (openFilePath === manuscriptPath) {
    return { ok: true, content: getLiveContent(), fromEditor: true };
  }

  try {
    return { ok: true, content: await readFile(manuscriptPath), fromEditor: false };
  } catch (err) {
    console.error(`Failed to read ${fileName}:`, err);
    return { ok: false, missingFile: fileName };
  }
}
