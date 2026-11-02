// @vitest-environment jsdom
/**
 * L'état d'enregistrement du document ouvert, dans la barre d'état.
 *
 * Il n'était affiché qu'avec un chemin : un tampon sans titre n'en a pas, et une page
 * entière pouvait s'y écrire sans que rien ne dise qu'elle n'était nulle part.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

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
  useEditorStore.setState({ filePath: null, isDirty: false });
});

describe('StatusBar : état d’enregistrement', () => {
  it('tampon sans titre modifié : il se voit', async () => {
    await mountWith({ filePath: null, isDirty: true });

    expect(screen.getByText('statusBar.unsaved')).toBeInTheDocument();
  });

  it('tampon sans titre vierge : rien à signaler', async () => {
    await mountWith({ filePath: null, isDirty: false });

    expect(screen.queryByText('statusBar.unsaved')).toBeNull();
    expect(screen.queryByText('statusBar.notSavedYet')).toBeNull();
  });

  it('témoin : un fichier ouvert et modifié reste signalé', async () => {
    await mountWith({ filePath: '/p/document.md', isDirty: true });

    expect(screen.getByText('statusBar.unsaved')).toBeInTheDocument();
  });
});
