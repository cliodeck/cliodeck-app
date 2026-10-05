/**
 * L'IA locale est-elle prise en charge par cette version de macOS ?
 *
 * ClioDeck démarre à partir de macOS 12, mais l'IA locale demande macOS 14 :
 * Ollama l'exige (« macOS Sonoma (v14) or newer »), et le moteur llama.cpp des
 * modèles embarqués est construit pour macOS 14 lui aussi. Essayé sur un Mac
 * Intel sous macOS 12 (2026-10-05) : Ollama ne s'installe pas, le modèle
 * embarqué répond, mais la recherche dans les sources ne fonctionne pas.
 *
 * Rien dans l'app ne le disait : on découvrait la limite en cherchant
 * pourquoi rien ne s'indexait.
 */

/** Première version de macOS où Ollama et le moteur embarqué sont pris en charge. */
export const LOCAL_AI_MIN_MACOS = 14;

export interface LocalAiSupport {
  /** Ce macOS est trop ancien pour l'IA locale. */
  limited: boolean;
  /** Version de macOS telle que le système la donne (« 12.7.6 ») ; vide hors macOS. */
  macosVersion: string;
}

export function localAiSupport(input: {
  platform: NodeJS.Platform;
  /** `process.getSystemVersion()`. */
  systemVersion: string;
}): LocalAiSupport {
  if (input.platform !== 'darwin') return { limited: false, macosVersion: '' };
  const major = Number.parseInt(input.systemVersion.split('.')[0] ?? '', 10);
  // Version illisible : on ne prétend rien plutôt que d'alarmer à tort.
  if (!Number.isFinite(major)) return { limited: false, macosVersion: input.systemVersion };
  return { limited: major < LOCAL_AI_MIN_MACOS, macosVersion: input.systemVersion };
}
