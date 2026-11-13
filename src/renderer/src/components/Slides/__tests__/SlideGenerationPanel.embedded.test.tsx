// @vitest-environment jsdom
/**
 * Le modèle embarqué et sa fenêtre de 4 096 jetons (revue de L08-4).
 *
 * - Un refus du modèle arrive par `slides:stream-error`, avec son code : le panneau le dit dans la
 *   langue de l'interface, et la réponse brute de l'IPC, qui suit, ne le remplace pas.
 * - Un document plus long que la fenêtre est lu en partie : le panneau dit que seul son début a
 *   servi, au lieu de laisser croire que les slides couvrent tout le texte.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../stores/editorStore', () => ({
  useEditorStore: () => ({
    editorFacade: { getSelectionText: () => null, getValue: () => '# Chapitre\n\nDu texte.' },
  }),
}));
vi.mock('../../../stores/slidesStore', () => ({
  useSlidesStore: () => ({ closePanel: () => undefined }),
}));
vi.mock('../../../stores/bibliographyStore', () => ({
  useBibliographyStore: () => ({ citations: [] }),
}));

import { SlideGenerationPanel } from '../SlideGenerationPanel';

type DoneListener = (result: {
  content: string;
  cancelled?: boolean;
  sourceCut?: { readChars: number; totalChars: number };
}) => void;
type ErrorListener = (error: { error: string; code?: string }) => void;

/** Les écouteurs du panneau, et la réponse de `slides:generate`, pilotés par le test. */
function installSlidesBridge(): {
  done: () => DoneListener;
  error: () => ErrorListener;
  resolve: (res: { success: boolean; error?: string; model?: string }) => void;
} {
  let onDone: DoneListener | null = null;
  let onError: ErrorListener | null = null;
  let resolveGenerate: ((res: { success: boolean; error?: string; model?: string }) => void) | null = null;
  const unsubscribe = (): void => undefined;
  (window as unknown as { electron: Record<string, unknown> }).electron = {
    ...(window as unknown as { electron: Record<string, unknown> }).electron,
    slides: {
      onStream: () => unsubscribe,
      onStreamDone: (listener: DoneListener) => {
        onDone = listener;
        return unsubscribe;
      },
      onStreamError: (listener: ErrorListener) => {
        onError = listener;
        return unsubscribe;
      },
      generate: () =>
        new Promise((resolve) => {
          resolveGenerate = resolve;
        }),
      cancel: async () => undefined,
    },
  };
  const required = <T,>(value: T | null, name: string): T => {
    if (!value) throw new Error(`${name} non posé`);
    return value;
  };
  return {
    done: () => required(onDone, 'onStreamDone'),
    error: () => required(onError, 'onStreamError'),
    resolve: (res) => required(resolveGenerate, 'generate')(res),
  };
}

afterEach(() => cleanup());

describe('SlideGenerationPanel — modèle embarqué (L08-4)', () => {
  it('un refus du modèle embarqué se dit dans la langue de l’interface, et la réponse brute ne le remplace pas', async () => {
    const bridge = installSlidesBridge();
    render(<SlideGenerationPanel />);
    fireEvent.click(screen.getByText('slides.generate.generate'));
    await waitFor(() => expect(() => bridge.error()).not.toThrow());

    const raw = "The question needs 5000 tokens, more than the 2663 that the embedded model's 4096-token context window leaves for the input.";
    act(() => bridge.error()({ error: raw, code: 'embedded_prompt_too_long' }));
    await act(async () => bridge.resolve({ success: false, error: raw }));

    expect(screen.getByText('slides.generate.embeddedPromptTooLong')).toBeTruthy();
    expect(screen.queryByText(raw)).toBeNull();
    expect(screen.getByText('slides.generate.generate')).toBeTruthy();
  });

  it('une autre panne garde son message', async () => {
    const bridge = installSlidesBridge();
    render(<SlideGenerationPanel />);
    fireEvent.click(screen.getByText('slides.generate.generate'));
    await waitFor(() => expect(() => bridge.error()).not.toThrow());

    act(() => bridge.error()({ error: 'Could not load embedded model', code: 'embedded_load_failed' }));
    await act(async () => bridge.resolve({ success: false, error: 'Could not load embedded model' }));

    expect(screen.getByText('Could not load embedded model')).toBeTruthy();
  });

  it('document lu en partie : le panneau dit que seul le début a servi', async () => {
    const bridge = installSlidesBridge();
    render(<SlideGenerationPanel />);
    fireEvent.click(screen.getByText('slides.generate.generate'));
    await waitFor(() => expect(() => bridge.done()).not.toThrow());

    act(() =>
      bridge.done()({
        content: '# La grève\n\n## Le Havre, 1910',
        sourceCut: { readChars: 4000, totalChars: 16000 },
      })
    );
    await act(async () => bridge.resolve({ success: true, model: 'qwen2.5-0.5b' }));

    expect(screen.getByText('slides.generate.sourceCut')).toBeTruthy();
    // « Régénérer » efface la mention avec le résultat.
    fireEvent.click(screen.getByText('slides.generate.regenerate'));
    expect(screen.queryByText('slides.generate.sourceCut')).toBeNull();
  });

  it('document lu en entier : aucune mention', async () => {
    const bridge = installSlidesBridge();
    render(<SlideGenerationPanel />);
    fireEvent.click(screen.getByText('slides.generate.generate'));
    await waitFor(() => expect(() => bridge.done()).not.toThrow());

    act(() => bridge.done()({ content: '# La grève\n\n## Le Havre, 1910' }));
    await act(async () => bridge.resolve({ success: true, model: 'qwen2.5-0.5b' }));

    expect(screen.queryByText('slides.generate.sourceCut')).toBeNull();
  });
});
