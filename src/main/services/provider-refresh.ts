/**
 * Une seule reconstruction des fournisseurs après un changement de réglages, pour tous les services
 * qui en tiennent un : PDF (indexeur compris), recherche, Tropy.
 *
 * Chaque service construisait son registre à l'ouverture du projet, et chaque chemin de réglage en
 * refaisait une partie : `config:set('llm')` rouvrait le service PDF, le choix du fournisseur
 * d'embeddings ne refaisait que la recherche, un téléchargement que le registre PDF. Tropy n'était
 * jamais refait : décocher les embeddings cloud n'arrêtait pas l'envoi des transcriptions.
 */
import type { LLMConfig } from '../../../backend/types/config.js';
import { pdfService } from './pdf-service.js';
import { retrievalService } from './retrieval-service.js';
import { tropyService } from './tropy-service.js';

type ProviderRole = 'generation' | 'embedding';

/**
 * Ce que chaque champ de `llm` oblige à refaire. Un champ sans rôle est lu à chaque tour (`num_ctx`,
 * raisonnement) : le changer ne refait rien. Un `Record` sur toutes les clés : un champ ajouté à
 * `LLMConfig` sans être classé ici ne compile pas.
 *
 * `backend`, l'URL d'Ollama et les clés des services qui ont des embeddings servent aux deux : le
 * backend décide des embeddings cloud, et la clé part avec eux.
 */
const PROVIDER_ROLES: Record<keyof LLMConfig, readonly ProviderRole[]> = {
  backend: ['generation', 'embedding'],
  ollamaURL: ['generation', 'embedding'],
  ollamaChatModel: ['generation'],
  ollamaEmbeddingModel: ['embedding'],
  ollamaEmbeddingNumCtx: ['embedding'],
  ollamaNumCtx: [],
  ollamaThink: [],
  claudeAPIKey: ['generation'],
  claudeModel: ['generation'],
  openaiAPIKey: ['generation', 'embedding'],
  openaiModel: ['generation'],
  mistralAPIKey: ['generation', 'embedding'],
  mistralModel: ['generation'],
  geminiAPIKey: ['generation', 'embedding'],
  geminiModel: ['generation'],
  useCloudEmbeddings: ['embedding'],
  generationProvider: ['generation'],
  embeddedModelId: ['generation'],
  embeddedModelPath: ['generation'],
  embeddingProvider: ['embedding'],
  embeddedEmbeddingModelId: ['embedding'],
  embeddedEmbeddingModelPath: ['embedding'],
};

/** Ce qu'un enregistrement de la section `llm` change pour les fournisseurs. */
export function providerChanges(
  before: Partial<LLMConfig>,
  after: Partial<LLMConfig>
): { generation: boolean; embedding: boolean } {
  const changed = { generation: false, embedding: false };
  for (const [field, roles] of Object.entries(PROVIDER_ROLES) as Array<[keyof LLMConfig, readonly ProviderRole[]]>) {
    if (before[field] === after[field]) continue;
    for (const role of roles) changed[role] = true;
  }
  return changed;
}

/**
 * Refait les fournisseurs de tous les services depuis la configuration courante. Sans
 * `embeddingChanged`, seule la génération est refaite : ni attente des indexations, ni indexeur refait.
 *
 * Chaque service est refait même si un autre échoue : un échec du service PDF (configuration
 * invalide) ne doit pas laisser Tropy sur l'ancien fournisseur. La première erreur est relevée à la fin.
 */
export async function refreshProviders({ embeddingChanged }: { embeddingChanged: boolean }): Promise<void> {
  const errors: unknown[] = [];
  // Seul le service PDF attend quelque chose (ses indexations en vol, jusqu'à 30 s). Tropy et la
  // recherche partent avant lui : sinon, pendant cette attente, synchro et requêtes continueraient
  // d'aller vers l'ancien fournisseur — celui dont on vient peut-être de retirer le consentement.
  if (embeddingChanged) retrievalService.rebuildEmbeddingProvider();
  const tropy = tropyService.rebuildProviders({ embeddingChanged }).catch((e: unknown) => errors.push(e));
  const pdf = pdfService.refreshProviders({ embeddingChanged }).catch((e: unknown) => errors.push(e));
  await Promise.all([tropy, pdf]);
  if (errors.length > 0) throw errors[0];
}
