type Translate = (key: string, options?: Record<string, string>) => string;

/**
 * Le message d'un refus de création. Le main répond par un code
 * (`project_exists`, `project_files_exist`) ; un nom refusé arrive dans le
 * message de validation (« Validation failed: name: project_name_invalid »).
 */
export function createProjectErrorMessage(
  t: Translate,
  error: unknown,
  where: { name: string; folder: string }
): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('project_exists')) return t('project.createErrorExists', where);
  if (message.includes('project_files_exist')) return t('project.createErrorFilesExist', where);
  if (message.includes('project_name_invalid')) return t('project.createErrorNameInvalid');
  return t('project.createError');
}
