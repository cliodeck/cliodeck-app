/**
 * Journal d'usage IA — helpers purs pour l'annotation (parsing d'entrées CLI).
 *
 * Séparés de la boucle readline (dans `cli.ts`) pour rester testables sans TTY.
 * L'unité d'annotation est la **décision d'usage** (1 à 4 par jour), pas la requête ;
 * le rattachement sessions→décision est **entièrement manuel** (instructions §7).
 */

import type { Verdict } from './types.js';

const VERDICTS: Verdict[] = ['worth_it', 'not_worth_it', 'unsure', 'pending'];

/**
 * Interprète la saisie du verdict. Accepte le nom complet ou une initiale :
 * w=worth_it, n=not_worth_it, u=unsure, p=pending. Vide → `pending`.
 * Retourne `null` si la saisie est non reconnue (l'appelant redemande).
 */
export function parseVerdict(input: string): Verdict | null {
  const t = input.trim().toLowerCase();
  if (t === '') return 'pending';
  if ((VERDICTS as string[]).includes(t)) return t as Verdict;
  switch (t) {
    case 'w':
    case 'o': // « oui, ça valait le coup »
      return 'worth_it';
    case 'n':
      return 'not_worth_it';
    case 'u':
    case '?':
      return 'unsure';
    case 'p':
      return 'pending';
    default:
      return null;
  }
}

/**
 * Interprète une sélection de sessions par indices 1-based. Accepte :
 *   - `all` / `tout` / `*` → toutes
 *   - liste séparée par virgules/espaces : `1,3 5`
 *   - plages : `1-3`
 *   - vide → aucune
 * Retourne des indices 0-based, dédupliqués et bornés à [0, count).
 * Les jetons hors bornes ou non numériques sont ignorés silencieusement.
 */
export function parseSessionSelection(input: string, count: number): number[] {
  const t = input.trim().toLowerCase();
  if (t === '') return [];
  if (t === 'all' || t === 'tout' || t === '*') {
    return Array.from({ length: count }, (_, i) => i);
  }
  const out = new Set<number>();
  for (const tokenRaw of t.split(/[\s,]+/)) {
    const token = tokenRaw.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let n = lo; n <= hi; n++) {
        if (n >= 1 && n <= count) out.add(n - 1);
      }
      continue;
    }
    const n = parseInt(token, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= count) out.add(n - 1);
  }
  return [...out].sort((a, b) => a - b);
}

/** Date locale au format YYYY-MM-DD (clé de la table `usage_decisions`). */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
