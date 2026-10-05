/**
 * Ce macOS limite-t-il l'IA locale ?
 *
 * ClioDeck démarre à partir de macOS 12, mais Ollama exige macOS 14
 * (« macOS Sonoma (v14) or newer ») : en dessous, il ne s'installe pas. Le
 * moteur llama.cpp des modèles embarqués déclare macOS 14 lui aussi, sans
 * que cela l'empêche forcément de tourner — essayé sur un Mac Intel sous
 * macOS 12 (2026-10-05), le modèle de génération embarqué répond. Les
 * embeddings embarqués n'y ont pas été essayés.
 *
 * Rien dans l'app ne le disait : on découvrait la limite en cherchant
 * pourquoi rien ne s'indexait, sans savoir que les modèles embarqués — y
 * compris celui d'embeddings — restaient possibles.
 */

/** Première version de macOS où Ollama s'installe (et pour laquelle le moteur embarqué est construit). */
export const LOCAL_AI_MIN_MACOS = 14;

export interface LocalAiSupport {
  /** Ce macOS est trop ancien pour Ollama : en local, il ne reste que les modèles embarqués. */
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
