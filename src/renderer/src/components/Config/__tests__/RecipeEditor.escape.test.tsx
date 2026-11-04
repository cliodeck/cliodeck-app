// @vitest-environment jsdom
/**
 * Fermer l'éditeur de recette : la question quand il y a à perdre, et elle seule.
 *
 * Sans piège à lui, Échap fermait les Réglages qui le contiennent, et le YAML en cours partait
 * avec eux sans un mot (S17-1-6). Vrais Réglages autour, vrai CodeMirror, vrai dialogue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import type { ReactNode } from 'react';

const slot = vi.hoisted(() => ({ content: null as ReactNode }));
vi.mock('../ConfigPanel', () => ({ ConfigPanel: () => slot.content }));

import { RecipeEditor } from '../RecipeEditor';
import { SettingsModal } from '../SettingsModal';
import { ConfirmDialog } from '../../common/ConfirmDialog';
import { useDialogStore } from '../../../stores/dialogStore';

/** Un fichier écrit à la main : ni l'ordre ni les commentaires ne sont ceux de `yaml.dump`. */
const ON_DISK = `# Mon commentaire
name: ma-recette
version: '1'
description: Une recette
steps:
  - id: s1
    kind: brainstorm
`;

/** Un fichier à la forme de `yaml.dump` (enregistré depuis le formulaire), puis commenté à la main. */
const WITHOUT_COMMENT = `name: ma-recette
version: "1"
description: Une recette
inputs: {}
steps:
  - id: s1
    kind: brainstorm
outputs: {}
`;
const COMMENT = '# Mon commentaire\n';

const dialogs = () => useDialogStore.getState();
const closeEditor = vi.fn();
const closeSettings = vi.fn();
let save: ReturnType<typeof vi.fn>;

const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const pressEscape = () =>
  act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });
const nameField = () => document.querySelector('.config-field input') as HTMLInputElement;
const editorOverlay = () => document.querySelectorAll('.settings-modal')[1] as HTMLElement;
const typeName = (value: string) => fireEvent.change(nameField(), { target: { value } });
const closeButton = () => editorOverlay().querySelector('.close-btn') as HTMLElement;
const clickBackdrop = () =>
  act(async () => {
    fireEvent.mouseDown(editorOverlay());
    fireEvent.mouseUp(editorOverlay());
    fireEvent.click(editorOverlay());
  });
const toYaml = () => act(async () => fireEvent.click(screen.getByTitle('recipeEditor.modeYaml')));
const answer = (value: boolean) =>
  act(async () => {
    fireEvent.click(screen.getByText(value ? 'dialog.confirm' : 'dialog.cancel'));
  });

/** Une frappe dans le vrai CodeMirror, par une transaction : jsdom n'a pas de saisie. */
function yamlEdit(from: number, to: number, insert: string): void {
  const content = document.querySelector('.cm-content') as HTMLElement;
  const view = EditorView.findFromDOM(content) as EditorView;
  act(() => {
    view.dispatch({ changes: { from, to, insert } });
  });
}

async function renderEditor(scope: 'user' | 'builtin' = 'user', onSaved?: () => void): Promise<void> {
  slot.content = <RecipeEditor scope={scope} fileName="ma-recette.yaml" onClose={closeEditor} onSaved={onSaved} />;
  render(
    <>
      <SettingsModal isOpen onClose={closeSettings} />
      <ConfirmDialog />
    </>
  );
  await settle();
}

beforeEach(() => {
  closeEditor.mockClear();
  closeSettings.mockClear();
  save = vi.fn(async () => ({ success: true }));
  (window as unknown as { electron: unknown }).electron = {
    fusion: { recipes: { readYaml: vi.fn(async () => ({ success: true, yaml: ON_DISK })), save } },
  };
});

afterEach(() => {
  act(() => {
    while (dialogs().confirmOpen) dialogs().resolveConfirm(false);
  });
  cleanup();
});

describe('RecipeEditor : recette modifiée', () => {
  it('Échap : la question, et ni l’éditeur ni les Réglages ne se ferment', async () => {
    await renderEditor();
    typeName('autre-nom');

    await pressEscape();

    expect(dialogs().confirmOpen).toBe(true);
    expect(dialogs().confirmMessage).toBe('recipeEditor.discardConfirm');
    expect(closeEditor).not.toHaveBeenCalled();
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it('deux Échap d’affilée : une seule question, et le second vaut refus', async () => {
    await renderEditor();
    typeName('autre-nom');

    await pressEscape();
    expect(dialogs().queue).toHaveLength(1);

    await pressEscape();
    expect(dialogs().queue).toHaveLength(0);
    expect(closeEditor).not.toHaveBeenCalled();
    expect(closeSettings).not.toHaveBeenCalled();
    expect(nameField().value).toBe('autre-nom');
  });

  it('deux demandes dans le même instant : une seule question', async () => {
    await renderEditor();
    typeName('autre-nom');

    await act(async () => {
      fireEvent.click(closeButton());
      fireEvent.click(closeButton());
    });

    expect(dialogs().queue).toHaveLength(1);
  });

  it('refuser garde l’éditeur et sa saisie, et une nouvelle demande repose la question', async () => {
    await renderEditor();
    typeName('autre-nom');

    await pressEscape();
    await answer(false);
    expect(closeEditor).not.toHaveBeenCalled();
    expect(nameField().value).toBe('autre-nom');

    await pressEscape();
    expect(dialogs().confirmOpen).toBe(true);
  });

  it('accepter ferme l’éditeur, et lui seul', async () => {
    await renderEditor();
    typeName('autre-nom');

    await pressEscape();
    await answer(true);

    expect(closeEditor).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('le bouton X passe par la même question', async () => {
    await renderEditor();
    typeName('autre-nom');

    await act(async () => {
      fireEvent.click(closeButton());
    });

    expect(dialogs().confirmOpen).toBe(true);
    expect(closeEditor).not.toHaveBeenCalled();
  });

  it('le fond aussi, même imbriqué dans celui des Réglages', async () => {
    await renderEditor();
    typeName('autre-nom');

    await clickBackdrop();

    expect(dialogs().confirmOpen).toBe(true);
    expect(closeEditor).not.toHaveBeenCalled();
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it('une sélection qui finit sur le fond ne demande rien', async () => {
    await renderEditor();
    typeName('autre-nom');

    await act(async () => {
      fireEvent.mouseDown(nameField());
      fireEvent.click(editorOverlay());
    });

    expect(dialogs().confirmOpen).toBe(false);
    expect(closeEditor).not.toHaveBeenCalled();
  });

  it('enregistrée, plus de question ; modifiée de nouveau, elle revient', async () => {
    const onSaved = vi.fn();
    await renderEditor('user', onSaved);
    typeName('autre-nom');

    await act(async () => {
      fireEvent.click(screen.getByTitle('recipeEditor.save'));
    });
    expect(onSaved).toHaveBeenCalledTimes(1);

    typeName('encore-un-autre');
    await pressEscape();
    expect(dialogs().confirmOpen).toBe(true);
    await answer(false);

    await act(async () => {
      fireEvent.click(screen.getByTitle('recipeEditor.save'));
    });
    await pressEscape();
    expect(dialogs().confirmOpen).toBe(false);
    expect(closeEditor).toHaveBeenCalledTimes(1);
  });

  it('un enregistrement refusé : c’est toujours modifié', async () => {
    save.mockResolvedValueOnce({ success: false, error: 'disque plein' });
    await renderEditor();
    typeName('autre-nom');

    await act(async () => {
      fireEvent.click(screen.getByTitle('recipeEditor.save'));
    });
    await pressEscape();

    expect(dialogs().confirmOpen).toBe(true);
    expect(closeEditor).not.toHaveBeenCalled();
  });
});

describe('RecipeEditor : rien à perdre, pas de question', () => {
  it('sans modification, Échap ferme l’éditeur, et lui seul', async () => {
    await renderEditor();

    await pressEscape();

    expect(dialogs().confirmOpen).toBe(false);
    expect(closeEditor).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it('une recette en lecture seule se ferme sans question, par Échap, par le X et par le fond', async () => {
    await renderEditor('builtin');

    await pressEscape();
    expect(closeEditor).toHaveBeenCalledTimes(1);

    fireEvent.click(closeButton());
    expect(closeEditor).toHaveBeenCalledTimes(2);

    await clickBackdrop();
    expect(closeEditor).toHaveBeenCalledTimes(3);
    expect(dialogs().confirmOpen).toBe(false);
  });

  it('passer en YAML sans rien changer n’est pas une modification', async () => {
    await renderEditor();
    await toYaml();

    await pressEscape();

    expect(dialogs().confirmOpen).toBe(false);
    expect(closeEditor).toHaveBeenCalledTimes(1);
  });

  it('un YAML revenu à l’identique n’est pas une modification, et la mention « non enregistré » part avec', async () => {
    await renderEditor();
    await toYaml();

    yamlEdit(0, 0, 'x');
    expect(screen.queryByText(/recipeEditor\.unsaved/)).not.toBeNull();

    yamlEdit(0, 1, '');
    expect(screen.queryByText(/recipeEditor\.unsaved/)).toBeNull();

    await pressEscape();
    expect(dialogs().confirmOpen).toBe(false);
    expect(closeEditor).toHaveBeenCalledTimes(1);
  });

  it('un champ du formulaire revenu à sa valeur n’est pas une modification, même si le fichier a des commentaires', async () => {
    await renderEditor();

    typeName('autre-nom');
    expect(screen.queryByText(/recipeEditor\.unsaved/)).not.toBeNull();

    typeName('ma-recette');
    expect(screen.queryByText(/recipeEditor\.unsaved/)).toBeNull();

    await pressEscape();
    expect(dialogs().confirmOpen).toBe(false);
    expect(closeEditor).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('retirer un commentaire dans le YAML reste une modification : le formulaire ne l’aurait pas gardé, mais l’auteur l’a voulu', async () => {
    await renderEditor();
    await toYaml();

    yamlEdit(0, ON_DISK.indexOf('\n') + 1, '');

    await pressEscape();
    expect(dialogs().confirmOpen).toBe(true);
    expect(closeEditor).not.toHaveBeenCalled();
  });
});

describe('RecipeEditor : retirer un commentaire d’un fichier déjà à la forme de `yaml.dump`', () => {
  beforeEach(() => {
    (window as unknown as { electron: unknown }).electron = {
      fusion: { recipes: { readYaml: vi.fn(async () => ({ success: true, yaml: COMMENT + WITHOUT_COMMENT })), save } },
    };
  });

  it('dans le YAML, c’est une modification : la mention, Enregistrer et la question', async () => {
    await renderEditor();
    await toYaml();

    yamlEdit(0, COMMENT.length, '');

    expect(screen.queryByText(/recipeEditor\.unsaved/)).not.toBeNull();
    expect(screen.getByTitle('recipeEditor.save')).not.toBeDisabled();

    await pressEscape();
    expect(dialogs().confirmOpen).toBe(true);
    expect(closeEditor).not.toHaveBeenCalled();
  });

  it('par le formulaire, un champ revenu à sa valeur n’en est pas une', async () => {
    await renderEditor();

    typeName('autre-nom');
    typeName('ma-recette');

    expect(screen.queryByText(/recipeEditor\.unsaved/)).toBeNull();
    await pressEscape();
    expect(dialogs().confirmOpen).toBe(false);
    expect(closeEditor).toHaveBeenCalledTimes(1);
  });
});

describe('RecipeEditor : Tab', () => {
  it('boucle dans l’éditeur, pas dans les Réglages', async () => {
    await renderEditor();
    const focusables = editorOverlay().querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select, textarea');
    const last = focusables[focusables.length - 1];
    last.focus();

    fireEvent.keyDown(document, { key: 'Tab' });

    expect(editorOverlay().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
  });
});
