/**
 * Autorisation d'un chemin de document : validateur d'abord, registre de
 * consentement en repli.
 *
 * `editor:load-file` / `editor:save-file` écrivaient et lisaient n'importe
 * quel chemin absolu — de quoi laisser un renderer compromis siphonner
 * `~/.ssh/id_rsa` puis l'exfiltrer via le chat (ADR 0005). Le registre de
 * consentement préserve les usages légitimes hors projet : ouvrir un
 * document rangé ailleurs, « Enregistrer sous ».
 *
 * Extrait du handler pour être testable pour de vrai. Le test qui existait
 * RECOPIAIT cette logique caractère pour caractère, faute de pouvoir
 * importer un module qui exige un runtime Electron complet : inverser
 * l'ordre validateur/consentement dans le handler l'aurait laissé vert.
 */
import path from 'path';
import { validateReadPath, validateWritePath } from './path-validator.js';
import { isConsentedPath } from './user-consented-paths.js';

export async function authorizeDocumentPath(
  filePath: string,
  intent: 'read' | 'write'
): Promise<string> {
  try {
    return intent === 'read'
      ? await validateReadPath(filePath)
      : await validateWritePath(filePath);
  } catch (error) {
    // Le registre n'est alimenté que par le retour des dialogues natifs :
    // le renderer ne peut rien y ajouter lui-même.
    if (await isConsentedPath(filePath)) return path.resolve(filePath);
    throw error;
  }
}
