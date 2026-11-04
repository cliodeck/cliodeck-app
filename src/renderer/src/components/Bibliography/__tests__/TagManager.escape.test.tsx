// @vitest-environment jsdom
/**
 * Échap dans la saisie d'un tag vide la saisie. Tant qu'il y a quelque chose à y vider, la touche
 * s'arrête là : le panneau de recherche du manuscrit, ouvert à côté, ne se ferme pas avec.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TagManager } from '../TagManager';
import { useFocusTrap } from '../../../hooks/useFocusTrap';

afterEach(() => cleanup());

function renderBesidePanel(closePanel: () => void) {
  function SearchPanel() {
    useFocusTrap({ active: true, onEscape: closePanel, restoreFocus: false });
    return null;
  }
  render(
    <>
      <TagManager tags={[]} onTagsChange={vi.fn()} allTags={['archives']} />
      <SearchPanel />
    </>
  );
  return screen.getByRole('textbox') as HTMLInputElement;
}

describe('TagManager : Échap', () => {
  it('une saisie en cours : la vide, et le panneau reste', () => {
    const closePanel = vi.fn();
    const input = renderBesidePanel(closePanel);
    fireEvent.change(input, { target: { value: 'arch' } });

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input.value).toBe('');
    expect(closePanel).not.toHaveBeenCalled();
  });

  it('rien à vider : la touche passe', () => {
    const closePanel = vi.fn();
    const input = renderBesidePanel(closePanel);

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(closePanel).toHaveBeenCalledTimes(1);
  });
});
