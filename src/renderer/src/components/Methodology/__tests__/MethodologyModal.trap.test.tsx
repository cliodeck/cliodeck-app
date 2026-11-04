// @vitest-environment jsdom
/**
 * La Méthodologie est une modale dans toutes ses vues. Son piège n'avait de conteneur que sur la
 * fiche d'une fonctionnalité : en vue d'ensemble, Tab sortait dans la page derrière, et rien ne la
 * voyait ouverte, ni le menu qui change de panneau, ni le message d'une reconstruction.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MethodologyModal } from '../MethodologyModal';
import { isModalOpen } from '../../../hooks/useFocusTrap';

afterEach(() => cleanup());

const inModal = () => document.activeElement?.closest('.methodology-modal') ?? null;

function renderOverPage(): HTMLButtonElement {
  const { getByText } = render(
    <>
      <button>derrière</button>
      <MethodologyModal isOpen onClose={vi.fn()} />
    </>
  );
  const behind = getByText('derrière') as HTMLButtonElement;
  behind.focus();
  return behind;
}

describe('Méthodologie', () => {
  it('en vue d’ensemble : elle compte pour une modale, et Tab comme Maj+Tab y ramènent le focus', () => {
    const behind = renderOverPage();

    expect(isModalOpen()).toBe(true);

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(inModal()).not.toBeNull();

    behind.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(inModal()).not.toBeNull();
  });

  it('sur la fiche d’une fonctionnalité : même piège, le conteneur ne change pas avec la vue', () => {
    const behind = renderOverPage();

    fireEvent.click(screen.getByText('methodology.features'));
    expect(document.querySelector('.feature-detail')).not.toBeNull();
    expect(isModalOpen()).toBe(true);

    behind.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(inModal()).not.toBeNull();
  });
});
