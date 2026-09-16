// @vitest-environment jsdom
/**
 * Un refus renvoyé par `slides:generate` avant tout streaming — consentement
 * distant refusé, validation — n'émet aucun événement de flux. Le panneau
 * n'écoutait que ces événements : il restait bloqué sur « génération en
 * cours », sans rien dire.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

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

afterEach(() => cleanup());

describe('SlideGenerationPanel — refus avant génération', () => {
  it('affiche le refus et rend la main au lieu de rester en génération', async () => {
    const unsubscribe = (): void => undefined;
    (window as unknown as { electron: Record<string, unknown> }).electron = {
      ...(window as unknown as { electron: Record<string, unknown> }).electron,
      slides: {
        onStream: () => unsubscribe,
        onStreamDone: () => unsubscribe,
        onStreamError: () => unsubscribe,
        generate: async () => ({ success: false, error: 'Envoi vers Anthropic Claude annulé.' }),
        cancel: async () => undefined,
      },
    };

    render(<SlideGenerationPanel />);
    fireEvent.click(screen.getByText('slides.generate.generate'));

    await waitFor(() => {
      expect(screen.getByText('Envoi vers Anthropic Claude annulé.')).toBeTruthy();
    });
    expect(screen.queryByText('slides.generate.cancel')).toBeNull();
    expect(screen.getByText('slides.generate.generate')).toBeTruthy();
  });
});
