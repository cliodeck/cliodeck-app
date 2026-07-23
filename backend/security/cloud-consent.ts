/**
 * Consentement d'envoi vers un fournisseur distant (ADR 0005, phase 4.3).
 *
 * L'ADR promet un consentement explicite par session avant que le travail de
 * l'historien ne quitte sa machine. Jusqu'ici cette garantie vivait
 * uniquement dans le renderer (`useCloudConsentGuard`) : elle tenait par
 * discipline, pas par construction. Toute nouvelle surface d'envoi qui
 * oubliait le hook rouvrait le trou — ce qui s'est produit une fois, le
 * panneau « AI Assistant » ayant expédié des prompts sans dialogue.
 *
 * Ce module porte l'état et la décision dans le processus principal, seul
 * endroit qui sache réellement quel fournisseur va être appelé. Il reste pur
 * (aucun import Electron) pour être testable et importable des deux côtés :
 * la boîte de dialogue est injectée par l'appelant.
 *
 * Politique retenue :
 *   - fournisseur local (Ollama en loopback) : aucun consentement requis ;
 *   - fournisseur distant, consentement déjà accordé pour la session : passe ;
 *   - fournisseur distant sans consentement, avec une fenêtre pour demander :
 *     dialogue natif, la réponse est mémorisée pour la session ;
 *   - fournisseur distant sans consentement et **sans interface** (CLI,
 *     headless, recettes hors application) : refus. On ne peut pas demander,
 *     donc on ne suppose pas — fail-closed. Un chemin headless qui doit
 *     appeler un fournisseur distant l'accorde explicitement via
 *     `cloudConsent.grant()`.
 */

export interface ProviderClassification {
  isCloud: boolean;
  /** Libellé lisible, affiché dans le dialogue et journalisé. */
  providerName: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

const CLOUD_BACKENDS: Record<string, string> = {
  claude: 'Anthropic Claude',
  openai: 'OpenAI',
  mistral: 'Mistral AI',
  gemini: 'Google Gemini',
};

/**
 * Un fournisseur est « distant » dès que les données quittent la machine.
 * Miroir exact de `isCloudProvider` côté renderer : les deux doivent
 * classer identiquement, sans quoi l'utilisateur verrait un dialogue là où
 * le main n'en attend pas (ou l'inverse).
 */
export function classifyProvider(config: {
  backend?: string;
  ollamaURL?: string;
}): ProviderClassification {
  const backend = config.backend ?? '';

  const named = CLOUD_BACKENDS[backend];
  if (named) return { isCloud: true, providerName: named };

  if (backend === 'ollama' && config.ollamaURL) {
    try {
      const host = new URL(config.ollamaURL).hostname.toLowerCase();
      if (!LOCAL_HOSTS.has(host)) {
        return { isCloud: true, providerName: `Ollama (${host})` };
      }
    } catch {
      // URL malformée : on suppose local, comme le renderer.
    }
  }

  return { isCloud: false, providerName: 'local' };
}

/**
 * État de consentement, porté par le processus (donc par la session
 * applicative). Rien n'est persisté : relancer ClioDeck redemande.
 */
export class CloudConsentRegistry {
  private granted = false;
  private provider: string | null = null;

  isGranted(): boolean {
    return this.granted;
  }

  consentedProvider(): string | null {
    return this.provider;
  }

  grant(providerName: string): void {
    this.granted = true;
    this.provider = providerName;
  }

  revoke(): void {
    this.granted = false;
    this.provider = null;
  }
}

export const cloudConsent = new CloudConsentRegistry();

/** Sous-ensemble d'`Electron.Dialog` dont ce module a besoin. */
export interface ConsentPrompt {
  showMessageBox(options: {
    type: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    title: string;
    message: string;
    detail: string;
  }): Promise<{ response: number }>;
}

/**
 * Demande le consentement à l'utilisateur. Suit le patron déjà éprouvé de
 * `confirmMcpAdd` : décision prise dans le main, dialogue natif, refus par
 * défaut (`cancelId`).
 */
export async function confirmCloudUsage(
  providerName: string,
  prompt: ConsentPrompt
): Promise<boolean> {
  const res = await prompt.showMessageBox({
    type: 'warning',
    buttons: ['Annuler', 'Envoyer vers ce service'],
    defaultId: 0,
    cancelId: 0,
    title: 'Envoi vers un service distant',
    message: `Envoyer vos données à ${providerName} ?`,
    detail:
      `Le contenu de la conversation — questions, extraits de vos sources et ` +
      `de votre manuscrit — sera transmis à ${providerName}, hors de votre ` +
      `machine.\n\nCe choix vaut pour la session en cours.`,
  });
  return res.response === 1;
}

export type CloudConsentDecision =
  | { allowed: true; reason: 'local' | 'already-granted' | 'granted-now' }
  | { allowed: false; reason: 'declined' | 'no-interface'; providerName: string };

/**
 * Décision complète pour un tour de chat. `prompt` absent = pas d'interface
 * disponible (headless) : on refuse au lieu de supposer.
 */
export async function decideCloudConsent(
  config: { backend?: string; ollamaURL?: string },
  prompt: ConsentPrompt | null,
  registry: CloudConsentRegistry = cloudConsent
): Promise<CloudConsentDecision> {
  const { isCloud, providerName } = classifyProvider(config);
  if (!isCloud) return { allowed: true, reason: 'local' };
  if (registry.isGranted()) return { allowed: true, reason: 'already-granted' };
  if (!prompt) return { allowed: false, reason: 'no-interface', providerName };

  const accepted = await confirmCloudUsage(providerName, prompt);
  if (!accepted) return { allowed: false, reason: 'declined', providerName };

  registry.grant(providerName);
  return { allowed: true, reason: 'granted-now' };
}
