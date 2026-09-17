/**
 * Garde de consentement distant pour les handlers IPC qui appellent un LLM
 * hors du chat (ADR 0005, dette n° 17).
 *
 * Le chat vérifiait déjà le consentement dans le main
 * (`fusion-chat-service`), mais les recettes, la génération de diapositives et
 * le reclassement de la similarité construisaient leur registre et
 * envoyaient sans rien demander — ni dans le renderer, ni ici. Chaque handler
 * appelle ce garde **avant** de construire son registre, avec la même
 * configuration que celle qui servira à le construire.
 */

import { BrowserWindow, dialog, type WebContents } from 'electron';
import type { LLMConfig } from '../../../../backend/types/config.js';
import {
  cloudConsentRefusalMessage,
  decideCloudConsent,
  type CloudSendSurface,
  type ConsentPrompt,
} from '../../../../backend/security/cloud-consent.js';

/**
 * Fenêtre où poser la question : celle qui a émis la requête, sinon la
 * fenêtre active, sinon la première. `null` = pas d'interface, donc refus.
 */
export function consentPromptFor(sender?: WebContents | null): ConsentPrompt | null {
  const win =
    (sender ? BrowserWindow.fromWebContents(sender) : null) ??
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows()[0];
  if (!win) return null;
  return {
    showMessageBox: (options) => dialog.showMessageBox(win, options as never),
  };
}

/**
 * `null` si l'envoi peut partir (fournisseur local, ou consentement accordé
 * pour ce fournisseur pendant la session) ; sinon le message de refus à
 * renvoyer au renderer.
 */
export async function cloudConsentRefusal(
  surface: CloudSendSurface,
  cfg: Pick<LLMConfig, 'backend' | 'ollamaURL'>,
  sender?: WebContents | null
): Promise<string | null> {
  const decision = await decideCloudConsent(
    { backend: cfg.backend, ollamaURL: cfg.ollamaURL },
    consentPromptFor(sender),
    undefined,
    surface
  );
  if (decision.allowed === false) return cloudConsentRefusalMessage(decision);
  return null;
}
