import { openErrorKey, OutgoingSaveError } from '../../stores/editorStore';
import { ProjectOpenError } from '../../stores/projectStore';

type Translate = (key: string, options?: Record<string, string>) => string;

/**
 * Le message d'un refus de création. Le main répond par un code
 * (`project_exists`, `project_files_exist`) ; un nom refusé arrive dans le
 * message de validation (« Validation failed: name: project_name_invalid »).
 * Quand c'est le document ouvert qui ne s'écrit pas, le dossier choisi n'y est pour
 * rien : son message d'écriture n'est pas un code, même si son chemin y ressemble.
 * Quand un service n'a pas démarré après la création (`services_failed`), le projet
 * existe : le message le dit, et dit comment l'ouvrir.
 */
export function createProjectErrorMessage(
  t: Translate,
  error: unknown,
  where: { name: string; folder: string }
): string {
  if (error instanceof ProjectOpenError && error.code === 'services_failed') {
    return t('project.createServicesFailed', where);
  }
  const message = error instanceof Error && !(error instanceof OutgoingSaveError) ? error.message : '';
  if (message.includes('project_exists')) return t('project.createErrorExists', where);
  if (message.includes('project_files_exist')) return t('project.createErrorFilesExist', where);
  if (message.includes('project_name_invalid')) return t('project.createErrorNameInvalid');
  return t(openErrorKey(error, 'project.createError'));
}
