// @vitest-environment jsdom
/**
 * La valeur ne part qu'au blur ou à Entrée. Un champ vide ou illisible ne vaut rien : il revient à la
 * dernière valeur, sauf `allowEmpty`, où il veut dire « automatique ». Le vrai enchaînement du
 * navigateur (`blur` avant `click`) est prouvé en plus sur l'app réelle : `journey-numeric-fields`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { NumberInput } from '../NumberInput';

afterEach(cleanup);

const input = () => screen.getByRole('spinbutton') as HTMLInputElement;
const type = (value: string) => fireEvent.change(input(), { target: { value } });

/** Un parent qui tient la valeur, comme un formulaire, et un bouton qui lit ce qu'il tient. */
function Form({
  initial,
  onCommit,
  onSave,
  ...props
}: {
  initial: number | undefined;
  onCommit?: (value: number | undefined) => void;
  onSave?: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  allowEmpty?: boolean;
}): React.JSX.Element {
  const [value, setValue] = useState(initial);
  const { allowEmpty, ...rest } = props;
  const commit = (next: number | undefined) => {
    onCommit?.(next);
    setValue(next);
  };
  return (
    <>
      {allowEmpty ? (
        <NumberInput {...rest} allowEmpty value={value} onCommit={commit} />
      ) : (
        <NumberInput {...rest} value={value} onCommit={commit} />
      )}
      <output>{String(value)}</output>
      <button onClick={() => onSave?.(value)}>Enregistrer</button>
      <button onClick={() => setValue(14)}>Réinitialiser</button>
    </>
  );
}

describe('le brouillon', () => {
  it('reste un champ `number`, avec ses bornes et son pas, que les feuilles de style visent', () => {
    render(<NumberInput value={3} min={1} max={20} step={2} className="config-number" placeholder="p" onCommit={vi.fn()} />);
    expect(input().type).toBe('number');
    expect(input().getAttribute('min')).toBe('1');
    expect(input().getAttribute('max')).toBe('20');
    expect(input().getAttribute('step')).toBe('2');
    expect(input().className).toBe('config-number');
    expect(input().placeholder).toBe('p');
  });

  it('taper n’appelle rien, le blur valide', () => {
    const onCommit = vi.fn();
    render(<Form initial={3} onCommit={onCommit} />);
    type('12');
    expect(onCommit).not.toHaveBeenCalled();
    expect(input().value).toBe('12');
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(12);
  });

  it('un champ parcouru sans rien changer n’appelle rien', () => {
    const onCommit = vi.fn();
    render(<Form initial={3} onCommit={onCommit} />);
    fireEvent.focus(input());
    fireEvent.blur(input());
    type('3');
    fireEvent.blur(input());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('blur puis clic : le parent lit la valeur à jour', () => {
    const onSave = vi.fn();
    render(<Form initial={3} onSave={onSave} />);
    type('12');
    fireEvent.blur(input());
    fireEvent.click(screen.getByText('Enregistrer'));
    expect(onSave).toHaveBeenCalledExactlyOnceWith(12);
  });

  it('suit la valeur du parent hors édition : curseur, Réinitialiser, révocation', () => {
    render(<Form initial={15} />);
    fireEvent.click(screen.getByText('Réinitialiser'));
    expect(input().value).toBe('14');
  });

  it('ne survit pas au blur qui précède Réinitialiser', () => {
    render(<Form initial={15} />);
    type('21');
    fireEvent.blur(input());
    fireEvent.click(screen.getByText('Réinitialiser'));
    expect(input().value).toBe('14');
  });

  it('une valeur du parent qui change pendant la saisie n’efface pas ce qui est tapé', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<NumberInput value={15} onCommit={onCommit} />);
    type('21');
    rerender(<NumberInput value={14} onCommit={onCommit} />);
    expect(input().value).toBe('21');
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(21);
  });
});

describe('vide ou illisible', () => {
  it('au blur : pas d’appel, et la dernière valeur revient', () => {
    const onCommit = vi.fn();
    render(<Form initial={0.33} min={0} max={1} step={0.05} onCommit={onCommit} />);
    type('');
    expect(input().value).toBe('');
    fireEvent.blur(input());
    expect(onCommit).not.toHaveBeenCalled();
    expect(input().value).toBe('0.33');
  });

  it('à Entrée : pareil', () => {
    const onCommit = vi.fn();
    render(<Form initial={7} onCommit={onCommit} />);
    type('');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(input().value).toBe('7');
  });

  it('du texte que le navigateur ne sait pas lire (`1e`) n’est pas un champ vide, même avec `allowEmpty`', () => {
    const onCommit = vi.fn();
    render(<Form initial={8192} allowEmpty onCommit={onCommit} />);
    type('');
    Object.defineProperty(input(), 'validity', { configurable: true, value: { badInput: true } });
    fireEvent.blur(input());
    expect(onCommit).not.toHaveBeenCalled();
    expect(input().value).toBe('8192');
  });

  // Dans un champ déjà vide, `e` ou `-` ne font aucun `change` : la valeur reste `''`, et rien d'autre
  // ne dit que le champ montre du texte. Le geste réel est dans `journey-numeric-fields`.
  it.each([['au blur'], ['à Entrée']])('du texte illisible dans un champ vide, sans aucun change, disparaît %s', (geste) => {
    const onCommit = vi.fn();
    render(<Form initial={undefined} allowEmpty onCommit={onCommit} />);
    Object.defineProperty(input(), 'validity', { configurable: true, value: { badInput: true } });
    const written = vi.spyOn(input(), 'value', 'set');

    if (geste === 'au blur') fireEvent.blur(input());
    else fireEvent.keyDown(input(), { key: 'Enter' });

    expect(written).toHaveBeenCalledWith('');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each([[Number.NaN], [null], ['abc'], [Number.POSITIVE_INFINITY]])(
    'une valeur illisible du parent (%s) s’affiche vide, sans planter',
    (bad) => {
      render(<NumberInput value={bad as number} onCommit={vi.fn()} />);
      expect(input().value).toBe('');
    }
  );
});

describe('bornes et type', () => {
  it('au-dessus du maximum : borné, et l’auteur voit la valeur retenue', () => {
    const onCommit = vi.fn();
    render(<Form initial={7} min={1} max={20} onCommit={onCommit} />);
    type('99');
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(20);
    expect(input().value).toBe('20');
  });

  it('au-dessous du minimum : pareil', () => {
    const onCommit = vi.fn();
    render(<Form initial={7} min={1} max={20} onCommit={onCommit} />);
    type('-3');
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(1);
    expect(input().value).toBe('1');
  });

  it('déjà à la borne : pas d’appel, mais ce qui est tapé disparaît', () => {
    const onCommit = vi.fn();
    render(<Form initial={20} max={20} onCommit={onCommit} />);
    type('99');
    fireEvent.blur(input());
    expect(onCommit).not.toHaveBeenCalled();
    expect(input().value).toBe('20');
  });

  it('un entier reste entier, comme le faisait `parseInt`', () => {
    const onCommit = vi.fn();
    render(<Form initial={7} integer onCommit={onCommit} />);
    type('10.7');
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(10);
    expect(input().value).toBe('10');
  });

  it('une décimale reste une décimale', () => {
    const onCommit = vi.fn();
    render(<Form initial={0.33} onCommit={onCommit} />);
    type('0.5');
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(0.5);
  });

  it('`1e3` se lit 1000, et non 1 comme avec `parseInt`', () => {
    const onCommit = vi.fn();
    render(<Form initial={7} integer onCommit={onCommit} />);
    type('1e3');
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(1000);
  });
});

describe('le clavier', () => {
  it('Entrée valide, sans soumettre et sans quitter le champ ; le blur suivant n’appelle plus rien', () => {
    const onCommit = vi.fn();
    render(<Form initial={7} onCommit={onCommit} />);
    input().focus();
    type('12');

    const enter = createEvent.keyDown(input(), { key: 'Enter' });
    fireEvent(input(), enter);

    expect(enter.defaultPrevented).toBe(true);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(12);
    expect(document.activeElement).toBe(input());
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('Échap ne valide pas, et laisse la touche à la pile des modales', () => {
    const onCommit = vi.fn();
    render(<Form initial={7} onCommit={onCommit} />);
    type('12');

    const escape = createEvent.keyDown(input(), { key: 'Escape' });
    fireEvent(input(), escape);

    expect(onCommit).not.toHaveBeenCalled();
    // `useFocusTrap` ignore un événement déjà traité : la modale ne se fermerait plus.
    expect(escape.defaultPrevented).toBe(false);
  });
});

describe('allowEmpty', () => {
  it('vide veut dire automatique : `undefined`, une seule fois', () => {
    const onCommit = vi.fn();
    render(<Form initial={8192} allowEmpty onCommit={onCommit} />);
    type('');
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(input().value).toBe('');
    fireEvent.focus(input());
    type('');
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('déjà vide, parcouru sans rien changer : pas d’appel', () => {
    const onCommit = vi.fn();
    render(<Form initial={undefined} allowEmpty onCommit={onCommit} />);
    fireEvent.focus(input());
    fireEvent.blur(input());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('les bornes s’appliquent encore à ce qui est tapé', () => {
    const onCommit = vi.fn();
    render(<Form initial={undefined} allowEmpty min={512} onCommit={onCommit} />);
    type('100');
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(512);
  });

  // `ollama.ts` n'envoie `num_ctx` que s'il est positif : zéro veut dire « défaut du modèle ». Borné,
  // il partirait à 512 à chaque appel, et le texte embarqué serait tronqué.
  it.each([['0'], ['-3'], ['0.5']])('`%s` veut dire automatique, pas la borne', (typed) => {
    const onCommit = vi.fn();
    render(<Form initial={8192} allowEmpty integer min={512} onCommit={onCommit} />);
    type(typed);
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(input().value).toBe('');
  });

  it('déjà automatique : zéro disparaît, sans appel', () => {
    const onCommit = vi.fn();
    render(<Form initial={undefined} allowEmpty integer min={512} onCommit={onCommit} />);
    type('0');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(input().value).toBe('');
  });

  it('sans `allowEmpty`, zéro reste une valeur : bornée, ou retenue si les bornes l’admettent', () => {
    const bounded = vi.fn();
    const { unmount } = render(<Form initial={7} min={1} onCommit={bounded} />);
    type('0');
    fireEvent.blur(input());
    expect(bounded).toHaveBeenCalledExactlyOnceWith(1);
    unmount();

    const admitted = vi.fn();
    render(<Form initial={0.33} min={0} max={1} onCommit={admitted} />);
    type('0');
    fireEvent.blur(input());
    expect(admitted).toHaveBeenCalledExactlyOnceWith(0);
    expect(input().value).toBe('0');
  });
});

/**
 * D21 : une virgule tapée devient un point. Sous un Chromium anglais, la virgule n'entre pas dans un
 * `type="number"` et `0,5` se lit `05`. jsdom n'a pas `execCommand` : on relève ce qui est demandé au
 * navigateur. La vraie frappe, sous `--lang=en-US`, est dans `journey-numeric-fields`.
 */
describe('la virgule décimale', () => {
  let execCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true });
  });

  afterEach(() => {
    Reflect.deleteProperty(document, 'execCommand');
  });

  const pressComma = (init: KeyboardEventInit = {}) => {
    const event = createEvent.keyDown(input(), { key: ',', ...init });
    fireEvent(input(), event);
    return event;
  };

  it('champ à décimales : la virgule ne part pas au navigateur, un point est tapé à sa place', () => {
    render(<Form initial={0.33} min={0} max={1} step={0.05} />);
    const event = pressComma();
    expect(event.defaultPrevented).toBe(true);
    expect(execCommand).toHaveBeenCalledExactlyOnceWith('insertText', false, '.');
  });

  it('champ entier : rien ne change, la virgule n’a rien à devenir', () => {
    render(<Form initial={7} min={1} max={20} integer />);
    const event = pressComma();
    expect(event.defaultPrevented).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('un raccourci avec virgule (Cmd+,) n’est pas une frappe', () => {
    render(<Form initial={0.33} min={0} max={1} />);
    expect(pressComma({ metaKey: true }).defaultPrevented).toBe(false);
    expect(pressComma({ ctrlKey: true }).defaultPrevented).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });
});
