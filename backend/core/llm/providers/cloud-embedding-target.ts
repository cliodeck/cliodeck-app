/**
 * Le fournisseur d'embeddings en ligne qu'une configuration désigne, s'il y
 * en a un. Seule copie de la règle : l'adaptateur du registre la suit pour
 * construire le fournisseur, et les Réglages la consultent avant de changer
 * de backend et pour décider si Réinitialiser garde le backend
 * (`settings-persist.ts`) — `useCloudEmbeddings` est un drapeau global, mais le service
 * qui reçoit le corpus dépend du backend choisi (S17-1-31).
 *
 * Pur, sans import Node : le renderer l'importe.
 */

import type { LLMConfig } from '../../../types/config.js';

export interface CloudEmbeddingTarget {
  provider: 'gemini' | 'openai-compatible' | 'mistral';
  model: string;
  dimension: number;
  apiKey: string;
  baseUrl?: string;
}

/** Partiel : Réinitialiser l'interroge sur la section lue du disque, où tout peut manquer. */
type CloudEmbeddingFields = Partial<
  Pick<LLMConfig, 'backend' | 'useCloudEmbeddings' | 'geminiAPIKey' | 'openaiAPIKey' | 'mistralAPIKey'>
>;

/**
 * Seulement quand `useCloudEmbeddings` est coché ET que le backend choisi a
 * une API d'embeddings, avec sa clé. Anthropic n'en a pas : avec Claude, les
 * embeddings restent sur la chaîne locale (`null`).
 */
export function cloudEmbeddingTarget(cfg: CloudEmbeddingFields): CloudEmbeddingTarget | null {
  if (!cfg.useCloudEmbeddings) return null;
  switch (cfg.backend) {
    case 'gemini':
      return cfg.geminiAPIKey
        ? {
            provider: 'gemini',
            model: 'text-embedding-004',
            dimension: 768,
            apiKey: cfg.geminiAPIKey,
          }
        : null;
    case 'openai':
      return cfg.openaiAPIKey
        ? {
            provider: 'openai-compatible',
            model: 'text-embedding-3-small',
            dimension: 1536,
            apiKey: cfg.openaiAPIKey,
            baseUrl: 'https://api.openai.com/v1',
          }
        : null;
    case 'mistral':
      return cfg.mistralAPIKey
        ? {
            provider: 'mistral',
            model: 'mistral-embed',
            dimension: 1024,
            apiKey: cfg.mistralAPIKey,
          }
        : null;
    default:
      return null;
  }
}
