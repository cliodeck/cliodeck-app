/**
 * NERService - Named Entity Recognition using Ollama LLM
 *
 * Extracts named entities (persons, locations, dates, organizations, events)
 * from historical documents using a local LLM via Ollama.
 */

import { OllamaClient, GENERATION_PRESETS } from '../llm/OllamaClient';
import { EntityNormalizer, entityNormalizer } from './EntityNormalizer';
import type {
  EntityType,
  ExtractedEntity,
  NERExtractionResult,
} from '../../types/entity';

// MARK: - Constants

const NER_PROMPT_TEMPLATE = `Tu es un expert en reconnaissance d'entités nommées pour documents historiques.
Extrait TOUTES les entités du texte suivant et retourne-les au format JSON.

Types d'entités à extraire:
- PERSON: Noms de personnes (ex: "Charles de Gaulle", "Marie Curie", "Adolf Hitler")
- LOCATION: Lieux géographiques (ex: "Paris", "Allemagne", "Seine", "Londres")
- DATE: Dates et périodes (ex: "1914", "18 juin 1940", "XIXe siècle", "1914-1918")
- ORGANIZATION: Organisations, institutions, partis (ex: "OTAN", "Académie française", "Parti communiste")
- EVENT: Événements historiques (ex: "Bataille de Verdun", "Révolution française", "Appel du 18 juin")

Texte:
"""
{TEXT}
"""

IMPORTANT:
- Extrais TOUTES les entités, même si elles apparaissent plusieurs fois
- Pour chaque entité, inclus le contexte (la phrase où elle apparaît)
- Réponds UNIQUEMENT avec un JSON valide, sans texte avant ou après

Format de réponse:
[{"name": "...", "type": "PERSON|LOCATION|DATE|ORGANIZATION|EVENT", "context": "phrase où apparaît l'entité"}]`;

const NER_QUERY_PROMPT_TEMPLATE = `Extrait les entités nommées de cette question de recherche.

Types: PERSON, LOCATION, DATE, ORGANIZATION, EVENT

Question: "{QUERY}"

Réponds UNIQUEMENT avec un JSON:
[{"name": "...", "type": "..."}]`;

// Maximum text length to process at once (to avoid context limits)
const MAX_TEXT_LENGTH = 3000;

// MARK: - NERService

export class NERService {
  private ollamaClient: OllamaClient;
  private normalizer: EntityNormalizer;
  private modelOverride?: string;

  constructor(ollamaClient: OllamaClient, modelOverride?: string) {
    this.ollamaClient = ollamaClient;
    this.normalizer = entityNormalizer;
    this.modelOverride = modelOverride;
  }

  /**
   * Extracts named entities from a text using LLM
   */
  async extractEntities(text: string): Promise<NERExtractionResult> {
    const startTime = Date.now();
    const modelUsed = this.modelOverride || this.ollamaClient.chatModel;

    if (!text || text.trim().length < 10) {
      return {
        entities: [],
        processingTimeMs: 0,
        modelUsed,
        textLength: text?.length || 0,
      };
    }

    // Split text into chunks if too long
    const chunks = this.splitText(text, MAX_TEXT_LENGTH);
    const allEntities: ExtractedEntity[] = [];

    for (const chunk of chunks) {
      try {
        const entities = await this.extractFromChunk(chunk);
        allEntities.push(...entities);
      } catch (error) {
        console.warn('⚠️ [NER] Failed to extract from chunk:', error);
      }
    }

    // Deduplicate entities
    const dedupedEntities = this.deduplicateEntities(allEntities);

    const processingTimeMs = Date.now() - startTime;
    console.log(`🏷️ [NER] Extracted ${dedupedEntities.length} unique entities in ${processingTimeMs}ms`);

    return {
      entities: dedupedEntities,
      processingTimeMs,
      modelUsed,
      textLength: text.length,
    };
  }

  /**
   * Quick extraction for search queries (optimized for short text)
   */
  async extractQueryEntities(query: string): Promise<ExtractedEntity[]> {
    if (!query || query.trim().length < 3) {
      return [];
    }

    const startTime = Date.now();

    try {
      const prompt = NER_QUERY_PROMPT_TEMPLATE.replace('{QUERY}', query);

      // Use lower temperature for consistency
      let response = '';
      for await (const chunk of this.ollamaClient.generateResponseStream(
        prompt,
        [],
        this.modelOverride,
        30000, // 30s timeout for queries
        { ...GENERATION_PRESETS.deterministic }
      )) {
        response += chunk;
      }

      const entities = this.parseEntitiesFromResponse(response);

      console.log(`🏷️ [NER] Query entities: ${entities.length} in ${Date.now() - startTime}ms`);

      return entities;
    } catch (error) {
      console.warn('⚠️ [NER] Query extraction failed:', error);
      return [];
    }
  }

  /**
   * Extracts entities from a single chunk of text
   */
  private async extractFromChunk(text: string): Promise<ExtractedEntity[]> {
    const prompt = NER_PROMPT_TEMPLATE.replace('{TEXT}', text);

    let response = '';
    for await (const chunk of this.ollamaClient.generateResponseStream(
      prompt,
      [],
      this.modelOverride,
      120000, // 2 min timeout for long texts
      { ...GENERATION_PRESETS.academic, temperature: 0.1 }
    )) {
      response += chunk;
    }

    return this.parseEntitiesFromResponse(response);
  }

  /**
   * Parses entities from LLM response
   * Handles various JSON formats and malformed responses
   */
  private parseEntitiesFromResponse(response: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];

    try {
      // Try to extract JSON array from response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn('⚠️ [NER] No JSON array found in response');
        return this.fallbackParse(response);
      }

      const jsonStr = jsonMatch[0];
      const parsed = JSON.parse(jsonStr) as Array<{
        name?: string;
        type?: string;
        context?: string;
      }>;

      if (!Array.isArray(parsed)) {
        console.warn('⚠️ [NER] Parsed result is not an array');
        return [];
      }

      for (const item of parsed) {
        if (this.isValidEntity(item)) {
          entities.push({
            name: item.name!.trim(),
            type: this.normalizeType(item.type!),
            context: item.context?.trim() || '',
          });
        }
      }
    } catch (error) {
      console.warn('⚠️ [NER] JSON parse failed, using fallback:', error);
      return this.fallbackParse(response);
    }

    return entities;
  }

  /**
   * Fallback parsing using regex when JSON parsing fails
   */
  private fallbackParse(response: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];

    // Try to match individual entity patterns
    const entityPattern = /"name"\s*:\s*"([^"]+)"\s*,\s*"type"\s*:\s*"([^"]+)"/g;
    let match;

    while ((match = entityPattern.exec(response)) !== null) {
      const [, name, type] = match;
      if (name && type) {
        const normalizedType = this.normalizeType(type);
        if (normalizedType) {
          entities.push({
            name: name.trim(),
            type: normalizedType,
            context: '',
          });
        }
      }
    }

    return entities;
  }

  /**
   * Validates an entity object from parsed JSON
   */
  private isValidEntity(item: any): item is { name: string; type: string; context?: string } {
    return (
      typeof item === 'object' &&
      item !== null &&
      typeof item.name === 'string' &&
      item.name.trim().length > 0 &&
      typeof item.type === 'string' &&
      this.isValidType(item.type)
    );
  }

  /**
   * Checks if a type string is a valid EntityType
   */
  private isValidType(type: string): boolean {
    const validTypes = ['PERSON', 'LOCATION', 'DATE', 'ORGANIZATION', 'EVENT'];
    return validTypes.includes(type.toUpperCase());
  }

  /**
   * Normalizes a type string to EntityType
   */
  private normalizeType(type: string): EntityType {
    const upper = type.toUpperCase() as EntityType;
    if (['PERSON', 'LOCATION', 'DATE', 'ORGANIZATION', 'EVENT'].includes(upper)) {
      return upper;
    }
    // Default to EVENT for unknown types
    return 'EVENT';
  }

  /**
   * Deduplicates entities using the normalizer
   */
  private deduplicateEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
    const seen = new Map<string, ExtractedEntity>();

    for (const entity of entities) {
      const key = this.normalizer.getEntityKey(entity.name, entity.type);

      if (!seen.has(key)) {
        seen.set(key, entity);
      } else {
        // Keep the one with more context
        const existing = seen.get(key)!;
        if (entity.context.length > existing.context.length) {
          seen.set(key, entity);
        }
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Splits text into chunks that fit within the context window
   */
  private splitText(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks: string[] = [];
    let currentIndex = 0;

    while (currentIndex < text.length) {
      let endIndex = Math.min(currentIndex + maxLength, text.length);

      // Try to find a sentence boundary
      if (endIndex < text.length) {
        const searchStart = Math.max(currentIndex, endIndex - 200);
        const searchText = text.substring(searchStart, endIndex);
        const sentenceEndings = /[.!?]\s/g;
        let lastMatch = null;
        let match;

        while ((match = sentenceEndings.exec(searchText)) !== null) {
          lastMatch = match;
        }

        if (lastMatch) {
          endIndex = searchStart + lastMatch.index + 1;
        }
      }

      chunks.push(text.substring(currentIndex, endIndex).trim());
      currentIndex = endIndex;
    }

    return chunks;
  }

  /**
   * Batch extract entities from multiple texts
   */
  async extractEntitiesBatch(
    texts: Array<{ id: string; text: string }>,
    onProgress?: (current: number, total: number) => void
  ): Promise<Map<string, ExtractedEntity[]>> {
    const results = new Map<string, ExtractedEntity[]>();

    for (let i = 0; i < texts.length; i++) {
      const { id, text } = texts[i];
      onProgress?.(i + 1, texts.length);

      try {
        const result = await this.extractEntities(text);
        results.set(id, result.entities);
      } catch (error) {
        console.error(`❌ [NER] Failed to extract from ${id}:`, error);
        results.set(id, []);
      }
    }

    return results;
  }
}

// MARK: - Factory

export function createNERService(ollamaClient: OllamaClient, modelOverride?: string): NERService {
  return new NERService(ollamaClient, modelOverride);
}
