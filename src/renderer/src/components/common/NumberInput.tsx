import React, { useState } from 'react';

type NumberInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'min' | 'max' | 'step'
> & {
  value: number | undefined;
  min?: number;
  max?: number;
  step?: number;
  /** Tronque à l'entier, comme le `parseInt` d'avant : `10.7` donne `10`. */
  integer?: boolean;
} & (
    | {
        /** Vide veut dire « automatique » : `onCommit(undefined)`, et le champ quitte le fichier. */
        allowEmpty: true;
        onCommit: (value: number | undefined) => void;
      }
    | { allowEmpty?: false; onCommit: (value: number) => void }
  );

/**
 * Un champ numérique qui ne vaut qu'une fois validé, au blur ou à Entrée. Pendant la saisie il peut
 * être vide, ou dire `0,` ; le parent n'en sait rien. Un clic ailleurs retire d'abord le focus : un
 * bouton Enregistrer lit donc la valeur à jour. Échap ne valide pas, et ne s'arrête pas ici : la
 * touche va aux modales (`useFocusTrap`).
 *
 * Reste un `type="number"` : le navigateur y lit la virgule française, et les feuilles de style le
 * visent. Ce qu'il affiche après la saisie est ce qui a été retenu, borné ou non.
 */
export const NumberInput: React.FC<NumberInputProps> = ({
  value,
  min,
  max,
  integer,
  allowEmpty,
  onCommit,
  onKeyDown,
  ...rest
}) => {
  const [draft, setDraft] = useState<string | null>(null);
  // Un parent peut ne pas savoir ce qu'il tient : `null` ou une chaîne venus d'un fichier.
  const current = Number.isFinite(value) ? value : undefined;

  const commit = (input: HTMLInputElement): void => {
    if (draft === null) return;
    setDraft(null);
    // `1e` : le navigateur répond `''` sans effacer ce qu'il montre. Ce n'est pas un champ vidé.
    if (input.validity.badInput) {
      input.value = '';
      return;
    }
    if (draft.trim() === '') {
      if (allowEmpty && current !== undefined) onCommit(undefined);
      return;
    }
    let next = Number(draft);
    if (!Number.isFinite(next)) return;
    if (integer) next = Math.trunc(next);
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    if (next !== current) onCommit(next);
  };

  return (
    <input
      {...rest}
      type="number"
      min={min}
      max={max}
      value={draft ?? (current === undefined ? '' : String(current))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(e.currentTarget);
        }
        onKeyDown?.(e);
      }}
    />
  );
};
