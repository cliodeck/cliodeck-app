// @vitest-environment jsdom
/**
 * Le curseur survit désormais à un changement de mode : le navigateur et l'aperçu doivent le lire
 * en arrivant. Ils ne se mettaient à jour qu'au prochain déplacement, et surlignaient la diapositive 1
 * tant que le curseur restait sur la 5.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { EditorFacade } from '@/editor/facade';

import { SlideNavigator } from '../SlideNavigator';
import { SlidePreviewPanel } from '../SlidePreviewPanel';
import { useEditorStore } from '../../../stores/editorStore';

const DECK = ['# Une', '# Deux', '# Trois'].join('\n\n---\n\n');
const IN_THIRD = DECK.indexOf('# Trois') + 2;

interface FakeFacade {
  facade: EditorFacade;
  moveCursorTo(offset: number): void;
}

function facadeAt(offset: number): FakeFacade {
  const listeners = new Set<(position: number) => void>();
  return {
    facade: {
      getCursorOffset: () => offset,
      onContentChange: () => () => undefined,
      onSelectionChange: (callback: (position: number) => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    } as unknown as EditorFacade,
    moveCursorTo: (position) => {
      for (const listener of listeners) listener(position);
    },
  };
}

function setEditor(facade: EditorFacade | null): void {
  useEditorStore.setState({ content: DECK, editorFacade: facade });
}

afterEach(() => {
  cleanup();
  useEditorStore.setState({ content: '', editorFacade: null });
});

describe('le navigateur de diapositives', () => {
  const active = () => document.querySelector('.slide-navigator-item.active .slide-number')?.textContent;

  it('l’éditeur revient avec son curseur : le navigateur surligne sa diapositive', () => {
    setEditor(facadeAt(IN_THIRD).facade);
    render(<SlideNavigator />);
    expect(active()).toBe('3');
  });

  it('l’éditeur arrive après le navigateur : même chose', () => {
    setEditor(null);
    render(<SlideNavigator />);
    expect(active()).toBe('1');
    act(() => setEditor(facadeAt(IN_THIRD).facade));
    expect(active()).toBe('3');
  });

  it('il continue de suivre le curseur', () => {
    const { facade, moveCursorTo } = facadeAt(IN_THIRD);
    setEditor(facade);
    render(<SlideNavigator />);
    act(() => moveCursorTo(0));
    expect(active()).toBe('1');
  });
});

describe('l’aperçu des diapositives', () => {
  function stubPreview() {
    const getPreviewHtml = vi.fn(async (options: { activeSlideIndex: number }) => ({
      success: true,
      html: `<p>diapositive ${options.activeSlideIndex}</p>`,
    }));
    (window as unknown as { electron: Record<string, unknown> }).electron = {
      ...(window as unknown as { electron: Record<string, unknown> }).electron,
      slides: { getPreviewHtml },
    };
    return getPreviewHtml;
  }
  const shown = () => document.querySelector('iframe')?.getAttribute('srcdoc');

  it('l’éditeur arrive après l’aperçu, comme à un retour de mode : l’aperçu finit sur sa diapositive', async () => {
    const getPreviewHtml = stubPreview();
    setEditor(null);
    render(<SlidePreviewPanel />);
    await waitFor(() => expect(shown()).toBe('<p>diapositive 0</p>'));

    act(() => setEditor(facadeAt(IN_THIRD).facade));

    await waitFor(() => expect(shown()).toBe('<p>diapositive 2</p>'));
    expect(getPreviewHtml.mock.lastCall?.[0].activeSlideIndex).toBe(2);
  });

  it('l’aperçu s’ouvre sur un éditeur déjà là : il montre la diapositive du curseur', async () => {
    stubPreview();
    setEditor(facadeAt(IN_THIRD).facade);
    render(<SlidePreviewPanel />);
    await waitFor(() => expect(shown()).toBe('<p>diapositive 2</p>'));
  });
});
