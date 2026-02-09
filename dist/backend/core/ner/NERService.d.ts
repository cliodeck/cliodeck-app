/**
 * NERService - Named Entity Recognition using Ollama LLM
 *
 * Extracts named entities (persons, locations, dates, organizations, events)
 * from historical documents using a local LLM via Ollama.
 */
import { OllamaClient } from '../llm/OllamaClient';
import type { ExtractedEntity, NERExtractionResult } from '../../types/entity';
export declare class NERService {
    private ollamaClient;
    private normalizer;
    private modelOverride?;
    constructor(ollamaClient: OllamaClient, modelOverride?: string);
    /**
     * Extracts named entities from a text using LLM
     */
    extractEntities(text: string): Promise<NERExtractionResult>;
    /**
     * Quick extraction for search queries (optimized for short text)
     */
    extractQueryEntities(query: string): Promise<ExtractedEntity[]>;
    /**
     * Extracts entities from a single chunk of text
     */
    private extractFromChunk;
    /**
     * Parses entities from LLM response
     * Handles various JSON formats and malformed responses
     */
    private parseEntitiesFromResponse;
    /**
     * Fallback parsing using regex when JSON parsing fails
     */
    private fallbackParse;
    /**
     * Validates an entity object from parsed JSON
     */
    private isValidEntity;
    /**
     * Checks if a type string is a valid EntityType
     */
    private isValidType;
    /**
     * Normalizes a type string to EntityType
     */
    private normalizeType;
    /**
     * Deduplicates entities using the normalizer
     */
    private deduplicateEntities;
    /**
     * Splits text into chunks that fit within the context window
     */
    private splitText;
    /**
     * Batch extract entities from multiple texts
     */
    extractEntitiesBatch(texts: Array<{
        id: string;
        text: string;
    }>, onProgress?: (current: number, total: number) => void): Promise<Map<string, ExtractedEntity[]>>;
}
export declare function createNERService(ollamaClient: OllamaClient, modelOverride?: string): NERService;
