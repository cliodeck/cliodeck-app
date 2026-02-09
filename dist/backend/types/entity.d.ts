/**
 * Entity types for Named Entity Recognition (NER) in Graph RAG
 *
 * These types support the extraction and storage of named entities
 * from primary source documents (Tropy) for improved search relevance.
 */
export type EntityType = 'PERSON' | 'LOCATION' | 'DATE' | 'ORGANIZATION' | 'EVENT';
/**
 * Weights for entity types in search scoring
 * Higher weights boost relevance more strongly
 */
export declare const ENTITY_TYPE_WEIGHTS: Record<EntityType, number>;
/**
 * A unique entity in the knowledge graph
 */
export interface Entity {
    id: string;
    name: string;
    type: EntityType;
    normalizedName: string;
    aliases?: string[];
    createdAt: string;
}
/**
 * A mention of an entity in a specific chunk
 */
export interface EntityMention {
    id: string;
    entityId: string;
    chunkId: string;
    sourceId: string;
    startPosition?: number;
    endPosition?: number;
    context: string;
}
/**
 * A relationship between two entities (co-occurrence)
 */
export interface EntityRelation {
    entity1Id: string;
    entity2Id: string;
    relationType: 'co-occurrence' | 'mentioned-together';
    weight: number;
    sourceIds: string[];
}
/**
 * An entity extracted by the NER service (before deduplication)
 */
export interface ExtractedEntity {
    name: string;
    type: EntityType;
    context: string;
    confidence?: number;
    startPosition?: number;
    endPosition?: number;
}
/**
 * Result of NER extraction on a text
 */
export interface NERExtractionResult {
    entities: ExtractedEntity[];
    processingTimeMs: number;
    modelUsed: string;
    textLength: number;
}
/**
 * Configuration for entity-boosted search
 */
export interface EntitySearchConfig {
    enabled: boolean;
    hybridWeight: number;
    entityWeight: number;
    typeWeights: Record<EntityType, number>;
}
/**
 * Default search configuration
 */
export declare const DEFAULT_ENTITY_SEARCH_CONFIG: EntitySearchConfig;
/**
 * Entity match information for a search result
 */
export interface EntityMatchInfo {
    entityId: string;
    entityName: string;
    entityType: EntityType;
    matchScore: number;
    isExactMatch: boolean;
}
/**
 * Statistics about entities in the knowledge graph
 */
export interface EntityStatistics {
    totalEntities: number;
    byType: Record<EntityType, number>;
    totalMentions: number;
    totalRelations: number;
    topEntities: Array<{
        entity: Entity;
        mentionCount: number;
    }>;
}
