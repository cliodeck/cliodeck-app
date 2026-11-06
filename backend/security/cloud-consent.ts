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
 *   - fournisseur local (Ollama en loopback avec un modèle non hébergé,
 *     modèle embarqué) : aucun consentement requis ;
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

/** Noms d'hôte de la machine elle-même. Seule copie : `is-local.ts` l'importe. */
export const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
]);

/** Libellé des modèles qu'Ollama relaie vers ses propres serveurs. */
export const OLLAMA_CLOUD_PROVIDER_NAME = 'Ollama Cloud (ollama.com)';

/**
 * Le modèle est-il hébergé chez ollama.com ? Depuis sa 0.12, Ollama sert
 * par le démon local — même URL, même `/api/tags` — des modèles exécutés
 * sur ses serveurs, reconnaissables à leur étiquette : `gpt-oss:120b-cloud`,
 * `qwen3.5:cloud`. L'hôte seul ne dit donc plus où part le prompt.
 *
 * Règle du nom seulement : un modèle local renommé `xxx-cloud` coûte un
 * dialogue de trop, sans dommage ; un alias sans le suffixe (`ollama cp`)
 * reste invisible.
 */
export function isOllamaCloudModel(model?: string): boolean {
  const name = model?.trim().toLowerCase().replace(/:latest$/, '');
  if (!name) return false;
  return name.endsWith('-cloud') || name.endsWith(':cloud');
}

const CLOUD_BACKENDS: Record<string, string> = {
  claude: 'Anthropic Claude',
  openai: 'OpenAI',
  mistral: 'Mistral AI',
  gemini: 'Google Gemini',
};

/**
 * Un fournisseur est « distant » dès que les données quittent la machine.
 * Miroir de `isCloudProvider` côté renderer : les deux doivent classer
 * identiquement, sans quoi l'utilisateur verrait un dialogue là où le main
 * n'en attend pas (ou l'inverse). Le renderer ignore encore le modèle : pour
 * un modèle hébergé, c'est le dialogue natif du main qui demande.
 */
export function classifyProvider(config: {
  backend?: string;
  ollamaURL?: string;
  /** Modèle Ollama effectivement appelé : un modèle hébergé sort par l'Ollama local. */
  model?: string;
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

  if (backend === 'ollama' && isOllamaCloudModel(config.model)) {
    return { isCloud: true, providerName: OLLAMA_CLOUD_PROVIDER_NAME };
  }

  return { isCloud: false, providerName: 'local' };
}

/** Ce qui décide où part une génération : les champs de `LLMConfig` qu'en lit l'adaptateur. */
export interface GenerationTarget {
  backend?: string;
  ollamaURL?: string;
  ollamaChatModel?: string;
  generationProvider?: string;
  embeddedModelPath?: string;
}

/**
 * Où part la génération construite pour cette configuration ? Lit les
 * mêmes champs que `clioDeckConfigToRegistryConfig` : passer la
 * configuration du tour (modèle du panneau compris, après
 * `applyChatModelOverride`), celle qui construit le registre.
 *
 * - backend absent ou inconnu : l'adaptateur construit un Ollama, la
 *   classification aussi (avant, un backend absent passait pour local quel
 *   que soit l'hôte) ;
 * - génération embarquée effective (`embedded` avec un modèle présent) :
 *   llama.cpp en processus, rien ne part ;
 * - sinon le modèle Ollama de la configuration, avec le défaut de
 *   l'adaptateur.
 */
export function classifyGeneration(target: GenerationTarget): ProviderClassification {
  const backend = target.backend || 'ollama';
  if (CLOUD_BACKENDS[backend]) return classifyProvider({ backend });
  if (target.generationProvider === 'embedded' && target.embeddedModelPath) {
    return { isCloud: false, providerName: 'local' };
  }
  return classifyProvider({
    backend: 'ollama',
    ollamaURL: target.ollamaURL,
    model: target.ollamaChatModel || 'llama3.2',
  });
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
  config: GenerationTarget,
  prompt: ConsentPrompt | null,
  registry: CloudConsentRegistry = cloudConsent,
  surface: CloudSendSurface = 'chat'
): Promise<CloudConsentDecision> {
  return decideForClassification(classifyGeneration(config), prompt, registry, surface);
}

async function decideForClassification(
  { isCloud, providerName }: ProviderClassification,
  prompt: ConsentPrompt | null,
  registry: CloudConsentRegistry,
  surface: CloudSendSurface
): Promise<CloudConsentDecision> {
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

/** Où part le contenu : une génération, ou un calcul d'embeddings. */
export type EgressDestination =
  | { kind: 'generation'; target: GenerationTarget }
  | { kind: 'embedding'; target: { provider: string; baseUrl?: string; model?: string } };

/**
 * Ce qui part : un envoi de session (tour, recette, diapositives,
 * reclassement — dialogue ADR 0005), ou les notes de lecture, qui ont leur
 * propre réglage (`rag.readingNotesCloudConsent`) et n'ouvrent jamais de
 * dialogue : le consentement de session autorise le tour, pas ce corpus.
 */
export type EgressContent =
  | { kind: 'session-send'; surface: CloudSendSurface }
  | { kind: 'reading-notes'; consent: boolean };

export type EgressVerdict =
  | {
      allowed: true;
      isCloud: boolean;
      providerName: string;
      reason: 'local' | 'already-granted' | 'granted-now' | 'corpus-consent';
    }
  | {
      allowed: false;
      isCloud: true;
      providerName: string;
      reason: 'declined' | 'no-interface' | 'corpus-withheld';
    };

/**
 * Seule décision de sortie : classe la destination (modèle compris), puis
 * applique la règle du contenu. Le tour de chat et l'éligibilité de ses
 * notes de lecture passaient par deux classifications distinctes, toutes
 * deux aveugles au modèle — un modèle hébergé chez ollama.com recevait le
 * tour et les notes sans un mot.
 */
export async function egressGate(
  destination: EgressDestination,
  content: EgressContent,
  deps: { prompt?: ConsentPrompt | null; registry?: CloudConsentRegistry } = {}
): Promise<EgressVerdict> {
  const classification =
    destination.kind === 'generation'
      ? classifyGeneration(destination.target)
      : classifyEmbeddingTarget(destination.target);
  const { isCloud, providerName } = classification;

  if (content.kind === 'reading-notes') {
    if (!isCloud) return { allowed: true, isCloud, providerName, reason: 'local' };
    return content.consent
      ? { allowed: true, isCloud, providerName, reason: 'corpus-consent' }
      : { allowed: false, isCloud, providerName, reason: 'corpus-withheld' };
  }

  const decision = await decideForClassification(
    classification,
    deps.prompt ?? null,
    deps.registry ?? cloudConsent,
    content.surface
  );
  if (decision.allowed === false) {
    return { allowed: false, isCloud: true, providerName, reason: decision.reason };
  }
  return { allowed: true, isCloud, providerName, reason: decision.reason };
}

/** Message de refus lisible, commun à toutes les surfaces. */
export function cloudConsentRefusalMessage(
  decision: Extract<CloudConsentDecision | EgressVerdict, { allowed: false }>
): string {
  const { providerName, reason } = decision;
  switch (reason) {
    case 'no-interface':
      return `Envoi vers ${providerName} refusé : aucun consentement accordé pour cette session.`;
    case 'corpus-withheld':
      return `Notes de lecture non envoyées à ${providerName} : aucun consentement dans les réglages.`;
    case 'declined':
      return `Envoi vers ${providerName} annulé.`;
  }
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
  model?: string;
}): ProviderClassification {
  switch (embedding.provider) {
    case 'embedded':
      return { isCloud: false, providerName: 'local' };
    case 'ollama':
      return classifyProvider({
        backend: 'ollama',
        ollamaURL: embedding.baseUrl ?? 'http://127.0.0.1:11434',
        model: embedding.model,
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
