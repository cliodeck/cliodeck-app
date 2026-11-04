// @vitest-environment jsdom
/**
 * Les petites modales qui n'avaient pas de piège : Échap n'y faisait rien, et Tab en sortait.
 * Échap y vaut le bouton Annuler ou le X : rien n'y est en attente d'enregistrement, les options
 * de similarité s'appliquant à mesure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { CloudConsentDialog } from '../../Chat/CloudConsentDialog';
import { PDFSelectionDialog } from '../../Bibliography/PDFSelectionDialog';
import { SimilarityOptions } from '../../Similarity/SimilarityOptions';

const pressEscape = () =>
  act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });

afterEach(() => cleanup());

describe('Échap sur les petites modales', () => {
  it('consentement cloud : Échap vaut refus, jamais accord', async () => {
    const onCancel = vi.fn();
    const onConsent = vi.fn();
    render(<CloudConsentDialog providerName="Anthropic" onCancel={onCancel} onConsent={onConsent} />);

    await pressEscape();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConsent).not.toHaveBeenCalled();
  });

  it('choix d’un PDF : Échap annule, sans rien choisir', async () => {
    const onCancel = vi.fn();
    const onSelect = vi.fn();
    render(
      <PDFSelectionDialog
        citationTitle="Un article"
        attachments={[{ key: 'A', filename: 'a.pdf' } as never]}
        onCancel={onCancel}
        onSelect={onSelect}
      />
    );

    await pressEscape();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('options de similarité : Échap ferme', async () => {
    const onClose = vi.fn();
    render(<SimilarityOptions onClose={onClose} />);

    await pressEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
