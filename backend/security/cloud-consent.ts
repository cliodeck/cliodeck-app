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
 * Surfaces qui envoient du contenu à un fournisseur. Chacune a son propre
 * texte de dialogue : consentir sur la foi d'une description fausse (« le
 * contenu de la conversation » pour une génération de diapositives) n'est
 * pas consentir.
 */
export type CloudSendSurface = 'chat' | 'recipe' | 'slides' | 'similarity';

function consentDetail(surface: CloudSendSurface, providerName: string): string {
  switch (surface) {
    case 'chat':
      return (
        `Le contenu de la conversation — questions, extraits de vos sources et ` +
        `de votre manuscrit — sera transmis à ${providerName}, hors de votre ` +
        `machine.`
      );
    case 'recipe':
      return (
        `Les instructions de la recette — avec les valeurs que vous avez saisies ` +
        `et les résultats des étapes précédentes, qui peuvent contenir des ` +
        `extraits de vos sources — seront transmises à ${providerName}, hors de ` +
        `votre machine.`
      );
    case 'slides':
      return (
        `Le texte à transformer en diapositives — le document entier ou la ` +
        `sélection — sera transmis à ${providerName}, hors de votre machine.`
      );
    case 'similarity':
      return (
        `Pour classer les sources par pertinence, chaque passage analysé de ` +
        `votre texte et les extraits des sources candidates seront transmis à ` +
        `${providerName}, hors de votre machine. Pour rester en local, ` +
        `désactivez le reclassement par le modèle dans les options.`
      );
  }
}

/**
 * Demande le consentement à l'utilisateur. Suit le patron déjà éprouvé de
 * `confirmMcpAdd` : décision prise dans le main, dialogue natif, refus par
 * défaut (`cancelId`).
 */
export async function confirmCloudUsage(
  providerName: string,
  prompt: ConsentPrompt,
  surface: CloudSendSurface = 'chat'
): Promise<boolean> {
  const res = await prompt.showMessageBox({
    type: 'warning',
    buttons: ['Annuler', 'Envoyer vers ce service'],
    defaultId: 0,
    cancelId: 0,
    title: 'Envoi vers un service distant',
    message: `Envoyer vos données à ${providerName} ?`,
    detail: `${consentDetail(surface, providerName)}\n\nCe choix vaut pour la session en cours.`,
  });
  return res.response === 1;
}

export type CloudConsentDecision =
  | { allowed: true; reason: 'local' | 'already-granted' | 'granted-now' }
  | { allowed: false; reason: 'declined' | 'no-interface'; providerName: string };

/**
 * Décision complète pour un envoi (tour de chat, recette, diapositives,
 * reclassement). `prompt` absent = pas d'interface disponible (headless) :
 * on refuse au lieu de supposer.
 *
 * Le consentement est de session et par fournisseur, pas par surface : c'est
 * la promesse de l'ADR 0005. Accepté dans le chat, il vaut pour une recette
 * lancée ensuite vers le même fournisseur.
 */
export async function decideCloudConsent(
  config: { backend?: string; ollamaURL?: string },
  prompt: ConsentPrompt | null,
  registry: CloudConsentRegistry = cloudConsent,
  surface: CloudSendSurface = 'chat'
): Promise<CloudConsentDecision> {
  const { isCloud, providerName } = classifyProvider(config);
  if (!isCloud) return { allowed: true, reason: 'local' };
  // Le consentement vaut pour UN fournisseur, pas pour « le cloud » en
  // général. `consentedProvider()` existait déjà mais n'était jamais
  // comparé : accepter un envoi vers Mistral ouvrait silencieusement les
  // envois vers Anthropic dès que l'utilisateur changeait de backend.
  if (registry.isGranted() && registry.consentedProvider() === providerName) {
    return { allowed: true, reason: 'already-granted' };
  }
  if (!prompt) return { allowed: false, reason: 'no-interface', providerName };

  const accepted = await confirmCloudUsage(providerName, prompt, surface);
  if (!accepted) return { allowed: false, reason: 'declined', providerName };

  registry.grant(providerName);
  return { allowed: true, reason: 'granted-now' };
}

/** Message de refus lisible, commun à toutes les surfaces. */
export function cloudConsentRefusalMessage(
  decision: Extract<CloudConsentDecision, { allowed: false }>
): string {
  const { providerName, reason } = decision;
  return reason === 'no-interface'
    ? `Envoi vers ${providerName} refusé : aucun consentement accordé pour cette session.`
    : `Envoi vers ${providerName} annulé.`;
}

/**
 * Le fournisseur d'embeddings effectivement construit envoie-t-il le texte
 * hors de la machine ? Se lit sur la configuration **résolue** du registre
 * (`clioDeckConfigToRegistryConfig(cfg).embedding`), pas sur le backend de
 * génération : un backend Claude garde ses embeddings sur Ollama, et un
 * Ollama distant embarque à distance quel que soit le backend.
 *
 * Le repli éventuel n'entre pas en compte : il n'est essayé qu'après le
 * primaire, qui a donc déjà reçu le texte.
 */
export function classifyEmbeddingTarget(embedding: {
  provider: string;
  baseUrl?: string;
}): ProviderClassification {
  switch (embedding.provider) {
    case 'embedded':
      return { isCloud: false, providerName: 'local' };
    case 'ollama':
      return classifyProvider({
        backend: 'ollama',
        ollamaURL: embedding.baseUrl ?? 'http://127.0.0.1:11434',
      });
    case 'openai-compatible':
      if (embedding.baseUrl) {
        try {
          const host = new URL(embedding.baseUrl).hostname.toLowerCase();
          if (LOCAL_HOSTS.has(host)) return { isCloud: false, providerName: 'local' };
          return { isCloud: true, providerName: host === 'api.openai.com' ? 'OpenAI' : host };
        } catch {
          // URL malformée : on ne sait pas où part le texte, donc distant.
        }
      }
      return { isCloud: true, providerName: 'OpenAI' };
    case 'mistral':
      return { isCloud: true, providerName: 'Mistral AI' };
    case 'gemini':
      return { isCloud: true, providerName: 'Google Gemini' };
    default:
      // Fournisseur inconnu : fail-closed.
      return { isCloud: true, providerName: embedding.provider };
  }
}
