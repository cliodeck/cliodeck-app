import { describe, it, expect, vi } from 'vitest';
import type { MouseEvent } from 'react';
import { backdropClose } from '../backdropClose';

/**
 * Régression : sélectionner à la souris le texte d'un champ d'une modale
 * en relâchant le bouton hors du cadre fermait la modale. Le navigateur
 * envoie alors le `click` au fond (ancêtre commun des deux éléments).
 */
const backdrop = {} as EventTarget;
const field = {} as EventTarget;
const event = (target: EventTarget): MouseEvent<HTMLElement> =>
  ({ target, currentTarget: backdrop }) as unknown as MouseEvent<HTMLElement>;

describe('backdropClose', () => {
  it('ferme sur un clic commencé et fini sur le fond', () => {
    const onClose = vi.fn();
    const props = backdropClose(onClose);
    props.onMouseDown(event(backdrop));
    props.onClick(event(backdrop));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ne ferme pas quand la sélection part d’un champ et finit sur le fond', () => {
    const onClose = vi.fn();
    const props = backdropClose(onClose);
    props.onMouseDown(event(field)); // remonte jusqu'au fond, cible = le champ
    props.onClick(event(backdrop)); // clic attribué au fond par le navigateur
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ne ferme pas sur un clic dans le contenu', () => {
    const onClose = vi.fn();
    const props = backdropClose(onClose);
    props.onMouseDown(event(field));
    props.onClick(event(field));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ne ferme pas quand le geste part du fond et finit dans le contenu', () => {
    const onClose = vi.fn();
    const props = backdropClose(onClose);
    props.onMouseDown(event(backdrop));
    props.onClick(event(field));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('un geste ne déteint pas sur le suivant', () => {
    const onClose = vi.fn();
    const props = backdropClose(onClose);
    props.onMouseDown(event(backdrop));
    props.onClick(event(backdrop));
    props.onClick(event(backdrop)); // clic sans pression préalable sur le fond
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
