/**
 * Un champ dont le défaut est un nombre n'accepte qu'un nombre fini, sinon le défaut.
 *
 * `cliodeck-config.json` passe par JSON : le `NaN` d'un champ vidé y est devenu `null`, et un fichier
 * retouché à la main peut contenir n'importe quoi. Rien ne le signale ensuite : `null` passe le `??`
 * et le `||`, `selectWithOwnTextBands` lit `null <= 0` et rend zéro source, `similarity >= null` ne
 * filtre plus rien, `null.toFixed` démonte toute l'interface (S17-1-4).
 *
 * La règle ne regarde que les nombres. Un `null` ailleurs, un chemin de modèle, un champ que personne
 * ne connaît ou un champ qui manque ne sont pas des pannes. Rien dans DEFAULT_CONFIG ne vaut `null`.
 */
import { DEFAULT_CONFIG, type AppConfig } from '../../types/config.js';

export type NumericSection = 'rag' | 'llm' | 'editor';
export const NUMERIC_SECTIONS: readonly NumericSection[] = ['rag', 'llm', 'editor'];

/** Nombres sans valeur par défaut : absents, ils veulent dire « automatique », donc on les retire. */
const NUMBERS_WITHOUT_DEFAULT: Record<NumericSection, readonly string[]> = {
  rag: ['numCtx'],
  llm: ['ollamaNumCtx', 'ollamaEmbeddingNumCtx'],
  editor: [],
};

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Vrai si `value` n'a pas sa place dans un champ dont le défaut est `fallback`. */
export function isBadNumber(fallback: unknown, value: unknown): boolean {
  return typeof fallback === 'number' && !Number.isFinite(value);
}

function repairFields(defaults: Fields, saved: Fields, withoutDefault: readonly string[] = []): Fields {
  let repaired = saved;
  const replace = (key: string, value: unknown): void => {
    if (repaired === saved) repaired = { ...saved };
    if (value === undefined) delete repaired[key];
    else repaired[key] = value;
  };
  for (const [key, value] of Object.entries(saved)) {
    const fallback = defaults[key];
    if (isBadNumber(fallback, value)) replace(key, fallback);
    else if (withoutDefault.includes(key) && !Number.isFinite(value)) replace(key, undefined);
    else if (isFields(fallback) && isFields(value)) {
      const nested = repairFields(fallback, value);
      if (nested !== value) replace(key, nested);
    }
  }
  return repaired;
}

/**
 * La section sans ses nombres abîmés. Le même objet si rien ne l'est : c'est ce qui dit qu'il n'y a
 * rien à réécrire. Un champ absent reste absent : un fichier ancien n'est pas abîmé, et un Enregistrer
 * n'écrit que ce qui a changé.
 */
export function repairNumbers<S extends NumericSection>(section: S, saved: unknown): AppConfig[S] {
  if (!isFields(saved)) return DEFAULT_CONFIG[section];
  const defaults = DEFAULT_CONFIG[section] as unknown as Fields;
  return repairFields(defaults, saved, NUMBERS_WITHOUT_DEFAULT[section]) as unknown as AppConfig[S];
}

/** Les nombres de la section par défaut : ce sur quoi retombe un service quand le fichier n'en dit rien. */
export function numericDefaults<S extends NumericSection>(section: S): Partial<AppConfig[S]> {
  const numbers = Object.entries(DEFAULT_CONFIG[section]).filter(([, value]) => typeof value === 'number');
  return Object.fromEntries(numbers) as Partial<AppConfig[S]>;
}
