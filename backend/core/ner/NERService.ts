/**
 * NERService — Named Entity Recognition using Ollama LLM
 *
 * Extracts named entities (persons, locations, dates, organizations, events,
 * concepts) from historical documents using a local LLM via Ollama.
 *
 * Consolidated in fusion step 2.3: kept the ClioDeck impl (richer — chunking,
 * deduplication via EntityNormalizer, query-specific extraction, multi-format
 * JSON parsing with regex fallback) and folded in ClioBrain's multilingual
 * prompts (fr/en/de) + the CONCEPT entity type. Language is selectable per
 * instance; default 'fr' preserves the existing call-site behavior.
 */

import { OllamaClient, GENERATION_PRESETS } from '../llm/OllamaClient';
import { EntityNormalizer, entityNormalizer } from './EntityNormalizer';
import type {
  EntityType,
  ExtractedEntity,
  NERExtractionResult,
} from '../../types/entity';
import type { LLMProvider } from '../llm/providers/base';

export type NERLanguage = 'fr' | 'en' | 'de';

// MARK: - Constants

const NER_PROMPT_FR = `Tu es un expert en reconnaissance d'entités nommées pour documents historiques.
Extrait TOUTES les entités du texte suivant et retourne-les au format JSON.

Types d'entités à extraire:
- PERSON: Noms de personnes (ex: "Charles de Gaulle", "Marie Curie", "Adolf Hitler")
- LOCATION: Lieux géographiques (ex: "Paris", "Allemagne", "Seine", "Londres")
- DATE: Dates et périodes (ex: "1914", "18 juin 1940", "XIXe siècle", "1914-1918")
- ORGANIZATION: Organisations, institutions, partis (ex: "OTAN", "Académie française", "Parti communiste")
- EVENT: Événements historiques (ex: "Bataille de Verdun", "Révolution française", "Appel du 18 juin")
- CONCEPT: Concepts / notions historiographiques (ex: "totalitarisme", "longue durée", "mémoire collective")

Texte:
"""
{TEXT}
"""

IMPORTANT:
- Extrais TOUTES les entités, même si elles apparaissent plusieurs fois
- Pour chaque entité, inclus le contexte (la phrase où elle apparaît)
- Réponds UNIQUEMENT avec un JSON valide, sans texte avant ou après

Format de réponse:
[{"name": "...", "type": "PERSON|LOCATION|DATE|ORGANIZATION|EVENT|CONCEPT", "context": "phrase où apparaît l'entité"}]`;

const NER_PROMPT_EN = `You are a named-entity recognition expert for historical documents.
Extract ALL entities from the following text and return them as JSON.

Entity types:
- PERSON: Names of people (e.g. "Winston Churchill", "Marie Curie")
- LOCATION: Geographic places (e.g. "Paris", "the Rhine", "London")
- DATE: Dates and periods (e.g. "1914", "18 June 1940", "19th century")
- ORGANIZATION: Organizations, institutions, parties
- EVENT: Historical events (e.g. "Battle of Verdun", "French Revolution")
- CONCEPT: Historiographical concepts (e.g. "totalitarianism", "longue durée")

Text:
"""
{TEXT}
"""

IMPORTANT:
- Extract ALL entities, even if they appear multiple times
- For each entity, include the sentence it appears in as "context"
- Reply ONLY with valid JSON, no text before or after

Response format:
[{"name": "...", "type": "PERSON|LOCATION|DATE|ORGANIZATION|EVENT|CONCEPT", "context": "sentence where the entity appears"}]`;

const NER_PROMPT_DE = `Du bist Experte für die Erkennung benannter Entitäten in historischen Dokumenten.
Extrahiere ALLE Entitäten aus dem folgenden Text und gib sie als JSON zurück.

Entitätstypen:
- PERSON: Personennamen
- LOCATION: Geografische Orte
- DATE: Daten und Zeiträume
- ORGANIZATION: Organisationen, Institutionen, Parteien
- EVENT: Historische Ereignisse
- CONCEPT: Historiografische Konzepte

Text:
"""
{TEXT}
"""

WICHTIG:
- Extrahiere ALLE Entitäten, auch wenn sie mehrfach vorkommen
- Füge für jede Entität den umgebenden Satz als "context" hinzu
- Antworte NUR mit gültigem JSON, ohne Text davor oder danach

Antwortformat:
[{"name": "...", "type": "PERSON|LOCATION|DATE|ORGANIZATION|EVENT|CONCEPT", "context": "Satz mit der Entität"}]`;

const NER_PROMPTS: Record<NERLanguage, string> = {
  fr: NER_PROMPT_FR,
  en: NER_PROMPT_EN,
  de: NER_PROMPT_DE,
};

const NER_QUERY_PROMPT_FR = `Extrait les entités nommées de cette question de recherche.

Types: PERSON, LOCATION, DATE, ORGANIZATION, EVENT, CONCEPT

Question: "{QUERY}"

Réponds UNIQUEMENT avec un JSON:
[{"name": "...", "type": "..."}]`;

const NER_QUERY_PROMPT_EN = `Extract named entities from this research query.

Types: PERSON, LOCATION, DATE, ORGANIZATION, EVENT, CONCEPT

Query: "{QUERY}"

Reply ONLY with JSON:
[{"name": "...", "type": "..."}]`;

const NER_QUERY_PROMPT_DE = `Extrahiere benannte Entitäten aus dieser Forschungsfrage.

Typen: PERSON, LOCATION, DATE, ORGANIZATION, EVENT, CONCEPT

Frage: "{QUERY}"

Antworte NUR mit JSON:
[{"name": "...", "type": "..."}]`;

const NER_QUERY_PROMPTS: Record<NERLanguage, string> = {
  fr: NER_QUERY_PROMPT_FR,
  en: NER_QUERY_PROMPT_EN,
  de: NER_QUERY_PROMPT_DE,
};

// Maximum text length to process at once (to avoid context limits)
const MAX_TEXT_LENGTH = 3000;

// MARK: - NERService

/**
 * Optional registry-driven provider (fusion step 1.4c).
 *
 * NERService historically took an `OllamaClient` and streamed via
 * `generateResponseStream`. The new optional `providers.llm` uses
 * `LLMProvider.complete()` (under the hood it accumulates the stream),
 * so new call sites — recipes, CLI, MCP tools — can pass a provider
 * selected at the workspace level instead of binding to Ollama
 * directly. Legacy OllamaClient callers keep their RAG-specific
 * timeout / error classification.
 */
export interface NERProviders {
  llm?: LLMProvider;
}

export class NERService {
  private ollamaClient: OllamaClient;
  private llm?: LLMProvider;
  private normalizer: EntityNormalizer;
  private modelOverride?: string;
  private language: NERLanguage;

  constructor(
    ollamaClient: OllamaClient,
    modelOverride?: string,
    language: NERLanguage = 'fr',
    providers?: NERProviders
  ) {
    this.ollamaClient = ollamaClient;
    this.llm = providers?.llm;
    this.normalizer = entityNormalizer;
    this.modelOverride = modelOverride;
    this.language = language;
  }

  setLanguage(language: NERLanguage): void {
    this.language = language;
  }

  setProviders(providers: NERProviders): void {
    if (providers.llm) this.llm = providers.llm;
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
      const prompt = NER_QUERY_PROMPTS[this.language].replace('{QUERY}', query);

      // Use lower temperature for consistency
      const response = await this.runPrompt(prompt, {
        ollama: {
          timeoutMs: 30000,
          options: { ...GENERATION_PRESETS.deterministic },
        },
        provider: { temperature: 0 },
      });

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
    const prompt = NER_PROMPTS[this.language].replace('{TEXT}', text);
    const response = await this.runPrompt(prompt, {
      ollama: {
        timeoutMs: 120000, // 2 min for long texts
        options: { ...GENERATION_PRESETS.academic, temperature: 0.1 },
      },
      provider: { temperature: 0.1 },
    });
    return this.parseEntitiesFromResponse(response);
  }

  /**
   * Unified LLM invocation. Prefers the typed provider when set (fusion
   * 1.4c); falls back to OllamaClient.generateResponseStream so existing
   * timeout + error classification behaviour is preserved for callers
   * that haven't migrated.
   */
  private async runPrompt(
    prompt: string,
    opts: {
      ollama: {
        timeoutMs: number;
        options: Partial<typeof GENERATION_PRESETS.academic> & { num_ctx?: number };
      };
      provider: { temperature?: number; maxTokens?: number };
    }
  ): Promise<string> {
    if (this.llm) {
      const ctrl = new AbortController();
      const timer = setTimeout(
        () => ctrl.abort(),
        opts.ollama.timeoutMs
      );
      try {
        return await this.llm.complete(prompt, {
          model: this.modelOverride,
          temperature: opts.provider.temperature,
          maxTokens: opts.provider.maxTokens,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    }
    let response = '';
    for await (const chunk of this.ollamaClient.generateResponseStream(
      prompt,
      [],
      this.modelOverride,
      opts.ollama.timeoutMs,
      opts.ollama.options
    )) {
      response += chunk;
    }
    return response;
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
    const validTypes = ['PERSON', 'LOCATION', 'DATE', 'ORGANIZATION', 'EVENT', 'CONCEPT'];
    return validTypes.includes(type.toUpperCase());
  }

  /**
   * Normalizes a type string to EntityType
   */
  private normalizeType(type: string): EntityType {
    const upper = type.toUpperCase() as EntityType;
    if (['PERSON', 'LOCATION', 'DATE', 'ORGANIZATION', 'EVENT', 'CONCEPT'].includes(upper)) {
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
