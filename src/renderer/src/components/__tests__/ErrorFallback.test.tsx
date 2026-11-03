// @vitest-environment jsdom
/**
 * « Réessayer » rechargeait la page sans écrire : ce que l'autosave n'avait pas encore
 * écrit partait avec elle, alors que le texte était encore dans le store.
 *
 * Vrai store, vrai filet d'écriture, le disque simulé derrière l'IPC. Le vrai plantage de
 * rendu, celui qui détruit la vue CodeMirror, est dans `e2e/journey-window-close.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ErrorFallback } from '../ErrorFallback';
import { useEditorStore } from '../../stores/editorStore';

const FILE = '/p/document.md';

let order: string[];
let onWrite: () => Promise<{ success: boolean; error?: string }>;
let resetErrorBoundary: Mock<() => void>;

function mount(): void {
  resetErrorBoundary = vi.fn(() => {
    order.push('reload');
  });
  render(<ErrorFallback error={new Error('Un plantage')} resetErrorBoundary={resetErrorBoundary} />);
}

const clickRetry = () => fireEvent.click(screen.getByRole('button', { name: 'errorFallback.retry' }));

beforeEach(() => {
  order = [];
  onWrite = async () => ({ success: true });
  (window as unknown as { electron: unknown }).electron = {
    editor: {
      saveFile: async (_path: string, content: string) => {
        order.push(`write:${content}`);
        return onWrite();
      },
    },
  };
  useEditorStore.setState({
    content: '',
    filePath: null,
    isDirty: false,
    editorFacade: null,
    bufferDetached: false,
    switchLock: null,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ErrorFallback', () => {
  it('document modifié : Réessayer écrit AVANT de recharger', async () => {
    useEditorStore.setState({ filePath: FILE, content: 'Dernière phrase.', isDirty: true });
    mount();
    clickRetry();
    await waitFor(() => expect(resetErrorBoundary).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['write:Dernière phrase.', 'reload']);
  });

  it('document propre : Réessayer recharge, sans écriture ni message', async () => {
    useEditorStore.setState({ filePath: FILE, content: 'Texte.', isDirty: false });
    mount();
    clickRetry();
    await waitFor(() => expect(resetErrorBoundary).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['reload']);
  });

  it('écriture refusée : pas de rechargement, le message, et le bouton de secours', async () => {
    useEditorStore.setState({ filePath: FILE, content: 'Dernière phrase.', isDirty: true });
    onWrite = async () => ({ success: false, error: 'EACCES' });
    mount();
    expect(screen.queryByRole('button', { name: 'errorFallback.reloadAnyway' })).toBeNull();

    clickRetry();

    expect(await screen.findByText('errorFallback.saveFailed')).toBeInTheDocument();
    expect(resetErrorBoundary).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'errorFallback.reloadAnyway' }));
    expect(resetErrorBoundary).toHaveBeenCalledTimes(1);
  });

  it('écriture refusée : le second essai écrit, et le message s’en va', async () => {
    useEditorStore.setState({ filePath: FILE, content: 'Dernière phrase.', isDirty: true });
    onWrite = async () => ({ success: false, error: 'EACCES' });
    mount();
    clickRetry();
    await screen.findByText('errorFallback.saveFailed');

    onWrite = async () => ({ success: true });
    clickRetry();

    await waitFor(() => expect(resetErrorBoundary).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['write:Dernière phrase.', 'write:Dernière phrase.', 'reload']);
  });

  it('tampon sans titre non vide : pas de rechargement, et le message dit pourquoi', async () => {
    useEditorStore.setState({ content: 'Une idée.', isDirty: true });
    mount();
    clickRetry();

    expect(await screen.findByText('errorFallback.untitledUnsaved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'errorFallback.reloadAnyway' })).toBeInTheDocument();
    expect(resetErrorBoundary).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it('tampon sans titre vide : rien à perdre, Réessayer recharge', async () => {
    mount();
    clickRetry();
    await waitFor(() => expect(resetErrorBoundary).toHaveBeenCalledTimes(1));
  });

  it('pendant l’écriture, un second clic ne relance rien', async () => {
    useEditorStore.setState({ filePath: FILE, content: 'Dernière phrase.', isDirty: true });
    let release: (value: { success: boolean }) => void = () => undefined;
    onWrite = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    mount();
    clickRetry();
    clickRetry();
    await waitFor(() => expect(order).toEqual(['write:Dernière phrase.']));

    release({ success: true });
    await waitFor(() => expect(resetErrorBoundary).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['write:Dernière phrase.', 'reload']);
  });

  it('écriture sans réponse : le bouton ne reste pas figé, le message et le secours arrivent', async () => {
    vi.useFakeTimers();
    useEditorStore.setState({ filePath: FILE, content: 'Dernière phrase.', isDirty: true });
    onWrite = () => new Promise(() => undefined);
    mount();
    clickRetry();
    expect(screen.getByRole('button', { name: 'errorFallback.retry' })).toBeDisabled();

    await act(() => vi.advanceTimersByTimeAsync(4000));

    expect(screen.getByText('errorFallback.saveFailed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'errorFallback.retry' })).toBeEnabled();
    expect(resetErrorBoundary).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'errorFallback.reloadAnyway' }));
    expect(resetErrorBoundary).toHaveBeenCalledTimes(1);
  });
});
