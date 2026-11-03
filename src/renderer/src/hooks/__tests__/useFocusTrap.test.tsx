// @vitest-environment jsdom
/**
 * Régression : 18 modales sur 20 n'écoutaient pas Échap, alors que ce hook
 * existait et n'était branché que sur ConfirmDialog et AlertDialog.
 *
 * Le hook exigeait que sa ref soit attachée à un conteneur AVANT de traiter
 * la moindre touche. Une modale qui l'appelait sans câbler la ref restait
 * donc insensible à Échap, sans le moindre signe. Échap est désormais
 * indépendant de la ref ; seul le piégeage du Tab en dépend.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { isModalOpen, useFocusTrap } from '../useFocusTrap';

afterEach(() => cleanup());

/** Modale qui n'attache PAS la ref — le cas des 18 modales branchées. */
function SansRef({ active, onEscape }: { active: boolean; onEscape: () => void }) {
  useFocusTrap({ active, onEscape });
  return <div>modale</div>;
}

/** Modale qui attache la ref — piégeage du Tab en plus. */
function AvecRef({ active, onEscape }: { active: boolean; onEscape: () => void }) {
  const ref = useFocusTrap({ active, onEscape });
  return (
    <div ref={ref}>
      <button>premier</button>
      <button>dernier</button>
    </div>
  );
}

describe('useFocusTrap — Échap', () => {
  it('ferme même quand la ref n’est pas attachée', () => {
    const onEscape = vi.fn();
    render(<SansRef active onEscape={onEscape} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('ferme aussi quand la ref est attachée', () => {
    const onEscape = vi.fn();
    render(<AvecRef active onEscape={onEscape} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('ne fait rien quand la modale est fermée', () => {
    const onEscape = vi.fn();
    render(<SansRef active={false} onEscape={onEscape} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onEscape).not.toHaveBeenCalled();
  });

  it('ignore les autres touches', () => {
    const onEscape = vi.fn();
    render(<SansRef active onEscape={onEscape} />);

    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'a' });

    expect(onEscape).not.toHaveBeenCalled();
  });

  it('cesse d’écouter après démontage', () => {
    const onEscape = vi.fn();
    const { unmount } = render(<SansRef active onEscape={onEscape} />);
    unmount();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onEscape).not.toHaveBeenCalled();
  });
});

describe('useFocusTrap — isModalOpen', () => {
  it('vrai tant qu’un piège est actif avec son conteneur, faux après sa fermeture', () => {
    const { rerender } = render(<AvecRef active onEscape={vi.fn()} />);
    expect(isModalOpen()).toBe(true);

    rerender(<AvecRef active={false} onEscape={vi.fn()} />);
    expect(isModalOpen()).toBe(false);
  });

  it('faux après le démontage', () => {
    const { unmount } = render(<AvecRef active onEscape={vi.fn()} />);
    unmount();

    expect(isModalOpen()).toBe(false);
  });

  it('faux pour un piège inactif, même monté', () => {
    render(<AvecRef active={false} onEscape={vi.fn()} />);

    expect(isModalOpen()).toBe(false);
  });

  it('faux pour un panneau sans conteneur, qui ne prend qu’Échap', () => {
    render(<SansRef active onEscape={vi.fn()} />);

    expect(isModalOpen()).toBe(false);
  });

  it('deux modales : la fermeture de l’une laisse l’autre compter', () => {
    const first = render(<AvecRef active onEscape={vi.fn()} />);
    const second = render(<AvecRef active onEscape={vi.fn()} />);

    first.unmount();
    expect(isModalOpen()).toBe(true);

    second.unmount();
    expect(isModalOpen()).toBe(false);
  });
});
