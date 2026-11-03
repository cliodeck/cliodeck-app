import { describe, it, expect } from 'vitest';
import { createProjectErrorMessage } from '../create-project-error';
import { OutgoingSaveError } from '../../../stores/editorStore';

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key} ${JSON.stringify(options)}` : key;

describe('createProjectErrorMessage', () => {
  const where = { name: 'These', folder: '/Documents' };

  it('nomme le projet et le dossier quand un projet existe déjà', () => {
    expect(createProjectErrorMessage(t, new Error('project_exists'), where)).toBe(
      `project.createErrorExists ${JSON.stringify(where)}`
    );
  });

  it('nomme le projet et le dossier quand des fichiers existent déjà', () => {
    expect(createProjectErrorMessage(t, new Error('project_files_exist'), where)).toBe(
      `project.createErrorFilesExist ${JSON.stringify(where)}`
    );
  });

  it('reconnaît le nom refusé dans le message de validation', () => {
    const error = new Error('Validation failed: name: project_name_invalid');
    expect(createProjectErrorMessage(t, error, where)).toBe('project.createErrorNameInvalid');
  });

  // Le dossier choisi n'y est pour rien, même quand le chemin du document ressemble à un code.
  it('le document ouvert qui ne s’écrit pas : le message parle de l’enregistrement', () => {
    const cause = new Error("EACCES: permission denied, access '/Documents/project_exists/document.md'");
    expect(createProjectErrorMessage(t, new OutgoingSaveError(cause), where)).toBe('toolbar.saveError');
  });

  it('garde le message général pour toute autre erreur', () => {
    expect(createProjectErrorMessage(t, new Error('EACCES'), where)).toBe('project.createError');
    expect(createProjectErrorMessage(t, 'inattendu', where)).toBe('project.createError');
  });
});
