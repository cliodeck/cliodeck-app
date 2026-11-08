// @vitest-environment jsdom
/**
 * L'état d'enregistrement du document ouvert, dans la barre d'état.
 *
 * Il n'était affiché qu'avec un chemin : un tampon sans titre n'en a pas, et une page
 * entière pouvait s'y écrire sans que rien ne dise qu'elle n'était nulle part.
 *
 * Et le fichier lui-même (G7) : rien à l'écran ne le nommait. Après « Enregistrer sous »,
 * l'éditeur reste sur le nouveau fichier, et l'auteur a changé les droits de document.md
 * alors qu'il en éditait un autre.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

// Le simulacre commun rend la clé seule : l'infobulle d'un fichier hors du projet doit
// porter son chemin, que seule l'interpolation y met.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && typeof params.path === 'string' ? `${key} ${params.path}` : key,
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { StatusBar } from '../StatusBar';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';

async function mountWith(state: { filePath: string | null; isDirty: boolean }): Promise<void> {
  useEditorStore.setState({ ...state, lastSavedAt: null });
  await act(async () => {
    render(<StatusBar />);
  });
}

beforeEach(() => {
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Projet',
      path: '/p',
      type: 'article',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
  });
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ currentProject: null });
  useEditorStore.setState({ filePath: null, isDirty: false, bufferDetached: false });
});

describe('StatusBar : état d’enregistrement', () => {
  it('tampon sans titre modifié : il se voit', async () => {
    await mountWith({ filePath: null, isDirty: true });

    expect(screen.getByText('statusBar.unsaved')).toBeInTheDocument();
  });

  it('tampon sans titre vierge : rien à signaler', async () => {
    await mountWith({ filePath: null, isDirty: false });

    expect(screen.queryByText('statusBar.unsaved')).toBeNull();
    expect(screen.queryByText('statusBar.notModified')).toBeNull();
  });

  it('document tout juste ouvert : « Non modifié », pas « Non enregistré », puisqu’il n’y a rien à écrire (D6)', async () => {
    await mountWith({ filePath: '/p/document.md', isDirty: false });

    expect(screen.getByText('statusBar.notModified')).toBeInTheDocument();
    expect(screen.getByTitle('statusBar.notModifiedTooltip')).toBeInTheDocument();
    expect(screen.queryByText('statusBar.notSavedYet')).toBeNull();
    expect(screen.queryByText('statusBar.unsaved')).toBeNull();
  });

  it('témoin : un fichier ouvert et modifié reste signalé', async () => {
    await mountWith({ filePath: '/p/document.md', isDirty: true });

    expect(screen.getByText('statusBar.unsaved')).toBeInTheDocument();
  });
});

/** L'élément qui nomme le fichier ouvert, s'il y en a un. */
const fileLabel = (): HTMLElement | null => document.querySelector('.status-bar__item--file');

describe('StatusBar : le fichier ouvert est nommé (G7)', () => {
  it('fichier du projet : son chemin relatif au projet, le chemin complet en infobulle', async () => {
    await mountWith({ filePath: '/p/chapters/03-guerre.md', isDirty: false });

    expect(fileLabel()).toHaveTextContent(/^chapters\/03-guerre\.md$/);
    expect(fileLabel()).toHaveAttribute('title', '/p/chapters/03-guerre.md');
  });

  it('fichier hors du projet : son nom seul, et l’infobulle dit où il est', async () => {
    // `/p-bis` n'est pas un dossier de `/p` : une comparaison de chaînes naïve l'y rangerait.
    await mountWith({ filePath: '/p-bis/notes/note.md', isDirty: false });

    expect(fileLabel()).toHaveTextContent(/^note\.md$/);
    expect(fileLabel()).toHaveAttribute('title', 'statusBar.fileOutsideProjectTooltip /p-bis/notes/note.md');
  });

  it('tampon sans titre : le libellé « sans titre »', async () => {
    await mountWith({ filePath: null, isDirty: false });

    expect(fileLabel()).toHaveTextContent(/^statusBar\.untitled$/);
  });

  it('la valeur suit l’éditeur : après « Enregistrer sous », la barre nomme le nouveau fichier', async () => {
    await mountWith({ filePath: '/p/document.md', isDirty: false });
    expect(fileLabel()).toHaveTextContent(/^document\.md$/);

    act(() => {
      useEditorStore.setState({ filePath: '/p/note.md' });
    });

    expect(fileLabel()).toHaveTextContent(/^note\.md$/);
  });

  it('sous Windows, une note ouverte par un dialogue est dans le projet : chemin relatif, sans « hors du projet »', async () => {
    // Le dossier du projet vient de `path.dirname`, le chemin de la note d'un dialogue ou de
    // `path.join` : barres obliques inverses des deux côtés.
    useProjectStore.setState({
      currentProject: {
        id: 'p1',
        name: 'Projet',
        path: 'C:\\Users\\h\\proj',
        type: 'article',
        createdAt: new Date(),
        lastOpenedAt: new Date(),
      },
    });
    await mountWith({ filePath: 'C:\\Users\\h\\proj\\reading-notes\\Lester_1935.md', isDirty: false });

    expect(fileLabel()).toHaveTextContent(/^reading-notes\/Lester_1935\.md$/);
    expect(fileLabel()).toHaveAttribute('title', 'C:\\Users\\h\\proj\\reading-notes\\Lester_1935.md');
  });

  it('un dossier long cède avant le nom du fichier : deux parties, le nom à part', async () => {
    await mountWith({ filePath: '/p/annexes-documentaires/transcription.md', isDirty: false });

    // La mise en page (le dossier se tronque, le nom reste entier) se vérifie dans l'app réelle ;
    // ici, la découpe qui la rend possible.
    expect(fileLabel()?.querySelector('.status-bar__file-dir')).toHaveTextContent(/^annexes-documentaires$/);
    expect(fileLabel()?.querySelector('.status-bar__file-name')).toHaveTextContent(/^\/transcription\.md$/);
  });

  it('témoin : hors de tout document, le temps d’un changement de projet, rien n’est nommé', async () => {
    useEditorStore.setState({ bufferDetached: true });
    await mountWith({ filePath: null, isDirty: false });

    expect(fileLabel()).toBeNull();
  });
});
