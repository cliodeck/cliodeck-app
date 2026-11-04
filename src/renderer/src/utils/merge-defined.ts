import { isBadNumber } from '@backend/core/config/repair-numbers';

/**
 * `saved` posé sur `defaults`, sans ce qui ne vaut rien : `undefined`, et ce qui n'est pas un nombre
 * fini dans un champ dont le défaut est un nombre. Un `null` ailleurs reste : il n'est pas à cette
 * fonction d'en juger, et un champ que `defaults` ne connaît pas passe tel quel.
 */
export function mergeDefined<T extends object>(defaults: T, saved: Partial<T> | null | undefined): T {
  const known = defaults as Record<string, unknown>;
  const present = Object.entries((saved ?? {}) as object).filter(
    ([key, value]) => value !== undefined && !isBadNumber(known[key], value)
  );
  return { ...defaults, ...Object.fromEntries(present) };
}
