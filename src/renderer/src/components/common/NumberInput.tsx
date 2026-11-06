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
        /**
         * Vide, zéro ou moins veut dire « automatique » : `onCommit(undefined)`, et le champ quitte le
         * fichier. `min` ne vaut que pour une valeur positive : c'est la convention de `num_ctx`
         * (`clampNumCtx`, `ollama.ts`), où `0` n'envoie rien alors que la borne enverrait 512.
         */
        allowEmpty: true;
        onCommit: (value: number | undefined) => void;
      }
    | { allowEmpty?: false; onCommit: (value: number) => void }
  );

/**
 * Une virgule tapée devient un point, à la frappe, quelle que soit la langue du système (D21). Le
 * séparateur d'un `type="number"` est celui de la locale de Chromium : sur un système anglais, la
 * virgule n'entrait pas, et `0,5` se lisait `05`, borné à 1. Le point se lit dans toutes les locales.
 * `insertText` passe par le chemin d'une vraie frappe : curseur, sélection, `input` et annulation.
 * Pour les seuls champs à décimales : dans un champ entier, la virgule n'a rien à devenir.
 */
export function typeDecimalPoint(event: React.KeyboardEvent<HTMLInputElement>): void {
  if (event.key !== ',' || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  document.execCommand('insertText', false, '.');
}

/**
 * Un champ numérique qui ne vaut qu'une fois validé, au blur ou à Entrée. Pendant la saisie il peut
 * être vide, ou dire `0,` ; le parent n'en sait rien. Un clic ailleurs retire d'abord le focus : un
 * bouton Enregistrer lit donc la valeur à jour. Échap ne valide pas, et ne s'arrête pas ici : la
 * touche va aux modales (`useFocusTrap`).
 *
 * Reste un `type="number"` : le navigateur y lit le séparateur décimal de sa locale, celle du système
 * (ou de `--lang`), pas la langue choisie dans l'app ; et les feuilles de style le visent. Une virgule
 * y devient donc un point à la frappe, sauf dans un champ entier. Ce qu'il affiche après la saisie est
 * ce qui a été retenu, borné ou non.
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
    // `1e` : le navigateur répond `''` sans effacer ce qu'il montre. Ce n'est pas un champ vidé. Et dans
    // un champ déjà vide, `e` ou `-` ne font aucun `change` : le brouillon n'en sait rien.
    if (input.validity.badInput) {
      setDraft(null);
      input.value = '';
      return;
    }
    if (draft === null) return;
    setDraft(null);
    const blank = draft.trim() === '';
    let next = blank ? 0 : Number(draft);
    if (!Number.isFinite(next)) return;
    if (integer) next = Math.trunc(next);
    if (allowEmpty && next <= 0) {
      if (current !== undefined) onCommit(undefined);
      return;
    }
    if (blank) return;
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
        if (!integer) typeDecimalPoint(e);
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(e.currentTarget);
        }
        onKeyDown?.(e);
      }}
    />
  );
};
