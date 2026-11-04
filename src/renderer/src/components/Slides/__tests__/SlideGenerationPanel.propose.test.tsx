// @vitest-environment jsdom
/**
 * Une diapositive générée n'entre dans le texte que par une proposition. Le repli écrivait
 * directement par `setValue` ou `appendText` si `propose` manquait ou refusait : une écriture de
 * l'IA sans décision, et le panneau se refermait sur le seul exemplaire du texte généré.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EditorFacade } from '@/editor/facade';

const h = vi.hoisted(() => ({
  facade: null as unknown,
  closePanel: vi.fn(),
}));

vi.mock('../../../stores/editorStore', () => ({
  useEditorStore: () => ({ editorFacade: h.facade }),
}));
vi.mock('../../../stores/slidesStore', () => ({
  useSlidesStore: () => ({ closePanel: h.closePanel }),
}));
vi.mock('../../../stores/bibliographyStore', () => ({
  useBibliographyStore: () => ({ citations: [] }),
}));

import { SlideGenerationPanel } from '../SlideGenerationPanel';

const DOCUMENT = '# Chapitre\n\nDu texte.';
const GENERATED = '# Diapositive générée';

function facadeWith(propose: EditorFacade['propose']): EditorFacade {
  return {
    getSelectionText: () => null,
    getValue: () => DOCUMENT,
    setValue: vi.fn(),
    appendText: vi.fn(),
    focus: vi.fn(),
    propose,
  } as unknown as EditorFacade;
}

async function generate(): Promise<void> {
  const unsubscribe = (): void => undefined;
  let finish: (payload: { content: string; cancelled: boolean }) => void = () => undefined;
  (window as unknown as { electron: Record<string, unknown> }).electron = {
    ...(window as unknown as { electron: Record<string, unknown> }).electron,
    slides: {
      onStream: () => unsubscribe,
      onStreamDone: (callback: typeof finish) => {
        finish = callback;
        return unsubscribe;
      },
      onStreamError: () => unsubscribe,
      generate: async () => ({ success: true, model: 'modele' }),
      cancel: async () => undefined,
    },
  };
  render(<SlideGenerationPanel />);
  fireEvent.click(screen.getByText('slides.generate.generate'));
  await waitFor(() => expect(screen.getByText('slides.generate.cancel')).toBeTruthy());
  act(() => finish({ content: GENERATED, cancelled: false }));
  await waitFor(() => expect(screen.getByText('slides.generate.append')).toBeTruthy());
}

afterEach(() => {
  cleanup();
  h.closePanel.mockClear();
});

describe('SlideGenerationPanel — appliquer', () => {
  it('« Ajouter » devient une proposition en fin de document', async () => {
    const propose = vi.fn(() => true);
    h.facade = facadeWith(propose);
    await generate();

    fireEvent.click(screen.getByText('slides.generate.append'));

    expect(propose).toHaveBeenCalledWith(
      expect.objectContaining({
        range: { from: DOCUMENT.length, to: DOCUMENT.length },
        proposed: `\n\n${GENERATED}`,
        category: 'slides-generation',
      })
    );
    expect(h.closePanel).toHaveBeenCalled();
  });

  it.each(['slides.generate.append', 'slides.generate.replace'])(
    '« %s » refusé par la vue : aucune écriture, et le panneau garde le texte généré',
    async (label) => {
      const facade = facadeWith(vi.fn(() => false));
      h.facade = facade;
      await generate();

      fireEvent.click(screen.getByText(label));

      expect(facade.setValue).not.toHaveBeenCalled();
      expect(facade.appendText).not.toHaveBeenCalled();
      expect(h.closePanel).not.toHaveBeenCalled();
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(GENERATED);
      expect(screen.getByText('editor.proposalUnavailable')).toBeTruthy();
    }
  );
});
