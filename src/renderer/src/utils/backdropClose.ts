import type { MouseEvent } from 'react';

/**
 * Fermeture d'une modale par clic sur son fond — et seulement par un clic
 * qui commence ET finit sur le fond.
 *
 * Un simple `onClick={onClose}` sur le fond fermait la modale dès qu'on
 * sélectionnait à la souris le texte d'un champ en débordant du cadre :
 * quand le bouton est pressé dans la modale et relâché sur le fond, le
 * navigateur envoie le `click` à leur ancêtre commun — le fond — et le
 * `stopPropagation` posé sur le contenu n'y peut rien, l'événement n'y
 * passant pas. On retient donc où le bouton a été pressé.
 *
 * Une variable de module suffit : il n'y a qu'un pointeur, donc qu'un
 * geste en cours. Ce n'est pas un hook, pour pouvoir servir dans les
 * composants qui rendent `null` avant d'atteindre leur JSX. Elle retient
 * l'élément pressé, pas un booléen : une modale ouverte dans une autre
 * (l'éditeur de recette dans les Réglages) voit le `mousedown` remonter
 * jusqu'au fond extérieur, qui n'en est pas la cible et aurait tout effacé.
 */
let pressedOn: EventTarget | null = null;

export function backdropClose(onClose: () => void): {
  onMouseDown: (e: MouseEvent<HTMLElement>) => void;
  onClick: (e: MouseEvent<HTMLElement>) => void;
} {
  return {
    onMouseDown: (e) => {
      pressedOn = e.target;
    },
    onClick: (e) => {
      const startedHere = pressedOn === e.currentTarget;
      pressedOn = null;
      if (startedHere && e.target === e.currentTarget) onClose();
    },
  };
}
